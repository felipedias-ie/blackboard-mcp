import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BlackboardClient, attemptIds, isDraftAttempt } from '../dist/client/index.js';

const config = {
  baseUrl: 'https://bb.example.edu',
  pageSize: 50,
  maxDownloadBytes: 1024 * 1024,
  allowWrites: false,
  extraHosts: [],
};

/**
 * A client over one grade record and its attempts. `attempts` maps attempt id
 * to status; an id missing from it answers 404, like an unreadable attempt.
 */
function clientFor(grade: Record<string, unknown> | null, attempts: Record<string, string>) {
  const http = {
    json: async (opts: { path: string }) => {
      if (/\/grades\/[^/]+\/attempts$/.test(opts.path)) return { results: [] };
      if (/\/columns\/[^/]+\/grades$/.test(opts.path)) return { results: grade ? [grade] : [] };
      const m = /\/gradebook\/attempts\/([^/]+)$/.exec(opts.path);
      if (m?.[1]) {
        const status = attempts[m[1]];
        if (!status) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
        return { id: m[1], status };
      }
      throw new Error(`unexpected request ${opts.path}`);
    },
  };
  return new BlackboardClient(http as never, config);
}

const status = (grade: Record<string, unknown> | null, attempts: Record<string, string> = {}) =>
  clientFor(grade, attempts).getSubmissionStatus('_1_1', '_c_1', '_u_1');

describe('submission status', () => {
  // Every shape below was measured on a real gradebook.

  test('a saved draft is not a submission', async () => {
    const s = await status(
      { id: 'g', lastAttemptId: 'a1', status: 'NEEDS_GRADING', submissionStatus: { status: 'DRAFT_SAVED_STUDENT' } },
      { a1: 'IN_PROGRESS' },
    );
    assert.equal(s.submitted, false);
    assert.equal(s.draft, true);
  });

  test('an earlier submission still counts when a newer draft is saved', async () => {
    // The record says DRAFT_SAVED_STUDENT here too, so it cannot be trusted alone.
    const s = await status(
      {
        id: 'g', lastAttemptId: 'a2', firstAttemptId: 'a1', status: 'NEEDS_GRADING',
        submissionStatus: { status: 'DRAFT_SAVED_STUDENT' },
      },
      { a1: 'NEEDS_GRADING', a2: 'IN_PROGRESS' },
    );
    assert.equal(s.submitted, true);
    assert.equal(s.draft, true);
    assert.equal(s.attemptId, 'a1', 'report the attempt that was handed in');
  });

  test('a graded record whose only attempt is a draft is not a submission', async () => {
    const s = await status({ id: 'g', lastAttemptId: 'a1', status: 'GRADED' }, { a1: 'IN_PROGRESS' });
    assert.equal(s.submitted, false);
  });

  test('a handed-in attempt is a submission', async () => {
    const s = await status({ id: 'g', lastAttemptId: 'a1', status: 'NEEDS_GRADING' }, { a1: 'NEEDS_GRADING' });
    assert.equal(s.submitted, true);
    assert.equal(s.draft, undefined);
    assert.equal(s.status, 'NEEDS_GRADING');
  });

  test('no attempt and no record both mean not submitted', async () => {
    assert.equal((await status({ id: 'g', status: 'GRADED' })).submitted, false);
    assert.equal((await status(null)).submitted, false);
  });

  test('an attempt that cannot be read is still taken as submitted', async () => {
    const s = await status({ id: 'g', lastAttemptId: 'a1' }, {});
    assert.equal(s.submitted, true);
    assert.equal(s.attemptId, 'a1');
  });
});

describe('attempt helpers', () => {
  test('attemptIds lists distinct ids, latest first', () => {
    assert.deepEqual(attemptIds({ lastAttemptId: 'b', firstAttemptId: 'a', highestAttemptId: 'b' }), ['b', 'a']);
    assert.deepEqual(attemptIds({ lastAttemptId: null }), []);
  });

  test('only IN_PROGRESS is a draft', () => {
    assert.equal(isDraftAttempt({ status: 'IN_PROGRESS' }), true);
    for (const s of ['NEEDS_GRADING', 'COMPLETED', 'GRADED', undefined]) {
      assert.equal(isDraftAttempt({ status: s }), false);
    }
  });
});
