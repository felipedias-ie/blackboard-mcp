import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BlackboardClient, rebucketSubmitted, type BbTodoItem } from '../dist/client/index.js';

const config = {
  baseUrl: 'https://bb.example.edu',
  pageSize: 50,
  maxDownloadBytes: 1024 * 1024,
  allowWrites: false,
  extraHosts: [],
};

describe('todo submission annotation', () => {
  test('rebucketSubmitted moves only action-bucket items with a submitted column', () => {
    const items = [
      { _bucket: 'overdue', column: { id: '_c1_1' } },
      { _bucket: 'overdue', column: { id: '_c2_1' } },
      { _bucket: 'dueToday', column: { id: '_c1_1' } },
      { _bucket: 'upcoming', column: { id: '_c1_1' } },
      { _bucket: 'overdue' },
    ] as BbTodoItem[];
    const out = rebucketSubmitted(items, new Set(['_c1_1']));
    assert.deepEqual(
      out.map((i) => i._bucket),
      ['submitted', 'overdue', 'submitted', 'upcoming', 'overdue'],
    );
  });

  test('rebucketSubmitted is a no-op when nothing was submitted', () => {
    const items = [{ _bucket: 'overdue', column: { id: '_c1_1' } }] as BbTodoItem[];
    assert.deepEqual(rebucketSubmitted(items, new Set()), items);
  });
});

describe('listTodo submitted bucket', () => {
  /**
   * One course whose to-do list holds every grade-record shape measured on a
   * real gradebook. `attempts` maps attempt id to status; a missing id is a 404.
   */
  function fixture() {
    const item = (id: string, bucket: 'overdue' | 'upcoming') => ({
      title: id,
      dueDate: '2026-10-01T21:00:00.000Z',
      column: { id, courseId: '_1_1' },
      _b: bucket,
    });
    const listed = [
      item('draft-only', 'overdue'),
      item('submitted-then-draft', 'overdue'),
      item('graded-draft-only', 'overdue'),
      item('submitted', 'overdue'),
      item('no-attempt', 'overdue'),
      item('unreadable', 'overdue'),
      item('submitted-upcoming', 'upcoming'),
    ];
    const rows = [
      { columnId: 'draft-only', lastAttemptId: 'a1', submissionStatus: { status: 'DRAFT_SAVED_STUDENT' } },
      { columnId: 'submitted-then-draft', lastAttemptId: 'a3', firstAttemptId: 'a2', submissionStatus: { status: 'DRAFT_SAVED_STUDENT' } },
      { columnId: 'graded-draft-only', lastAttemptId: 'a4', status: 'GRADED' },
      { columnId: 'submitted', lastAttemptId: 'a5', submissionStatus: { status: 'SUBMITTED' } },
      { columnId: 'no-attempt', status: 'GRADED' },
      { columnId: 'unreadable', lastAttemptId: 'a6' },
      { columnId: 'submitted-upcoming', lastAttemptId: 'a7' },
    ];
    const attempts: Record<string, string> = {
      a1: 'IN_PROGRESS', a2: 'NEEDS_GRADING', a3: 'IN_PROGRESS', a4: 'IN_PROGRESS', a5: 'NEEDS_GRADING', a7: 'NEEDS_GRADING',
    };
    const requested: string[] = [];
    const http = {
      session: { persist: async () => {} },
      json: async (opts: { path: string; method?: string; body?: unknown }) => {
        if (opts.path.endsWith('/calendars/todo/studentItems')) {
          const strip = ({ _b, ...rest }: (typeof listed)[number]) => rest;
          return {
            overdueItems: listed.filter((i) => i._b === 'overdue').map(strip),
            futureDueItems: listed.filter((i) => i._b === 'upcoming').map(strip),
          };
        }
        if (opts.path.endsWith('/users/me')) return { id: '_u_1' };
        if (opts.method === 'PUT') {
          return (opts.body as unknown[]).map(() => ({ status: 200, body: { results: rows } }));
        }
        const m = /\/gradebook\/attempts\/([^/]+)$/.exec(opts.path);
        if (m?.[1]) {
          requested.push(m[1]);
          const status = attempts[m[1]];
          if (!status) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' });
          return { id: m[1], status };
        }
        throw new Error(`unexpected request ${opts.path}`);
      },
    };
    return { client: new BlackboardClient(http as never, config), requested };
  }

  test('moves only work that was really handed in', async () => {
    const { client, requested } = fixture();
    const out = await client.listTodo({ since: '2026-09-20T00:00:00Z', until: '2026-10-05T00:00:00Z' });
    const bucket = Object.fromEntries(out.map((i) => [i.column?.id, i._bucket]));

    assert.deepEqual(bucket, {
      // A saved draft is an attempt too, but it is not a submission.
      'draft-only': 'overdue',
      // The record says DRAFT_SAVED_STUDENT, yet an earlier attempt was handed in.
      'submitted-then-draft': 'submitted',
      // Graded by the instructor, but the student only ever saved a draft.
      'graded-draft-only': 'overdue',
      'submitted': 'submitted',
      'no-attempt': 'overdue',
      // Hiding work from Overdue needs proof; an unreadable attempt is not proof.
      'unreadable': 'overdue',
      'submitted-upcoming': 'upcoming',
    });
    assert.ok(!requested.includes('a7'), 'items outside overdue/due today are not checked');
  });
});
