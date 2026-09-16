import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

interface RpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/**
 * Drives the built server over stdio and returns the responses.
 *
 * Runs against a throwaway state directory so the suite can never read or
 * mutate a real stored session.
 */
async function rpc(requests: Array<Record<string, unknown>>): Promise<RpcResponse[]> {
  const home = mkdtempSync(join(tmpdir(), 'bbmcp-test-'));
  const child = spawn(process.execPath, [cli], {
    env: {
      ...process.env,
      BLACKBOARD_MCP_HOME: home,
      BLACKBOARD_MCP_LOG_LEVEL: 'silent',
      // Guarantee no inherited configuration leaks in.
      BLACKBOARD_URL: '',
      BLACKBOARD_COOKIE: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => {
    stdout += c;
  });

  for (const req of requests) {
    child.stdin.write(`${JSON.stringify(req)}\n`);
  }

  // Give the server a moment to answer, then close the stream.
  await new Promise((r) => setTimeout(r, 2500));
  child.stdin.end();
  child.kill('SIGTERM');

  return stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as RpcResponse);
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

test('initializes and reports server identity', async () => {
  const [res] = await rpc([initialize]);
  assert.ok(res, 'no response to initialize');
  assert.equal(res.error, undefined);
  const info = res.result?.serverInfo as { name?: string } | undefined;
  assert.equal(info?.name, 'blackboard-mcp');
  assert.ok(
    typeof res.result?.instructions === 'string' &&
      (res.result.instructions as string).includes('bb_list_courses'),
    'instructions should point the model at bb_list_courses',
  );
});

test('lists every tool group without a stored session', async () => {
  const responses = await rpc([
    initialize,
    initialized,
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const listing = responses.find((r) => r.id === 2);
  assert.ok(listing, 'no tools/list response');
  const tools = (listing.result?.tools ?? []) as Array<{ name: string; description?: string }>;

  // Capability listing must not require authentication: a client that cannot
  // enumerate tools before login is unusable.
  assert.ok(tools.length >= 20, `expected 20+ tools, got ${tools.length}`);

  for (const expected of [
    'bb_whoami', 'bb_session_status', 'bb_list_courses', 'bb_get_course',
    'bb_browse_course', 'bb_get_content', 'bb_search_content',
    'bb_read_file', 'bb_download_file', 'bb_list_files',
    'bb_list_grades', 'bb_get_grade_detail', 'bb_grade_summary',
    'bb_todo', 'bb_calendar', 'bb_announcements', 'bb_activity_stream',
    'bb_raw_request', 'bb_batch_request', 'bb_list_endpoints',
  ]) {
    assert.ok(
      tools.some((t) => t.name === expected),
      `missing tool: ${expected}`,
    );
  }

  // Every tool needs a description; that text is how the model chooses.
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 30, `${t.name} lacks a useful description`);
  }
});

test('exposes prompts and resources', async () => {
  const responses = await rpc([
    initialize,
    initialized,
    { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
    { jsonrpc: '2.0', id: 4, method: 'resources/list' },
  ]);

  const prompts = (responses.find((r) => r.id === 3)?.result?.prompts ?? []) as Array<{ name: string }>;
  for (const expected of ['whats_due', 'course_briefing', 'study_pack', 'catch_up', 'grade_report']) {
    assert.ok(prompts.some((p) => p.name === expected), `missing prompt: ${expected}`);
  }

  const resources = (responses.find((r) => r.id === 4)?.result?.resources ?? []) as Array<{ uri: string }>;
  assert.ok(resources.some((r) => r.uri === 'blackboard://courses'), 'missing courses resource');
});

test('an unauthenticated tool call returns a hint, not a crash', async () => {
  const responses = await rpc([
    initialize,
    initialized,
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bb_whoami', arguments: {} } },
  ]);

  const call = responses.find((r) => r.id === 5);
  assert.ok(call, 'no tools/call response');
  assert.equal(call.error, undefined, 'should not be a protocol error');
  assert.equal(call.result?.isError, true, 'should be flagged as a tool error');

  const content = (call.result?.content ?? []) as Array<{ text?: string }>;
  const body = content.map((c) => c.text ?? '').join('\n');
  assert.match(body, /NOT_CONFIGURED|NOT_AUTHENTICATED/, 'should name the error code');
  assert.match(body, /auth login/, 'should tell the user how to fix it');
});

test('the submission tool is declared as destructive and demands confirmation', async () => {
  const responses = await rpc([
    initialize,
    initialized,
    { jsonrpc: '2.0', id: 6, method: 'tools/list' },
  ]);
  const tools = (responses.find((r) => r.id === 6)?.result?.tools ?? []) as Array<{
    name: string;
    description?: string;
    annotations?: Record<string, unknown>;
    inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
  }>;

  const submit = tools.find((t) => t.name === 'bb_submit_assignment');
  assert.ok(submit, 'bb_submit_assignment should be registered');

  // A client showing tool annotations must be able to warn before this runs.
  assert.equal(submit.annotations?.readOnlyHint, false);
  assert.equal(submit.annotations?.destructiveHint, true);
  assert.equal(submit.annotations?.idempotentHint, false);

  // `confirm` must be required, so a model cannot submit by omitting it.
  assert.ok(
    submit.inputSchema?.required?.includes('confirm'),
    'confirm must be a required parameter',
  );

  // The description has to state the irreversibility, since that is the only
  // signal a model gets before deciding to call it.
  assert.match(submit.description ?? '', /CANNOT be undone|irreversible/i);

  // Saving a draft is the safe counterpart and must not be flagged destructive.
  const draft = tools.find((t) => t.name === 'bb_save_draft');
  assert.ok(draft, 'bb_save_draft should be registered');
  assert.equal(draft.annotations?.destructiveHint, false);
});
