import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BlackboardClient } from '../dist/client/index.js';

const config = {
  baseUrl: 'https://bb.example.edu',
  pageSize: 50,
  maxDownloadBytes: 1024 * 1024,
  allowWrites: false,
  extraHosts: [],
};

/** Serves canned pages in order and records what was asked for. */
function client(pages: Array<{ results: unknown[]; paging?: { nextPage?: string } }>) {
  const calls: Array<{ path: string; query: unknown }> = [];
  const http = {
    json: async (opts: { path: string; query?: unknown }) => {
      calls.push({ path: opts.path, query: opts.query });
      return pages[calls.length - 1] ?? { results: [] };
    },
  };
  return { c: new BlackboardClient(http as never, config), calls };
}

describe('pagination', () => {
  test('stops at a nextPage that does not move forward', async () => {
    // The calendar's real shape: everything in the window on page one, then a
    // "next" link that drops `since` and restarts at offset 0. Following it
    // fetched years of history outside the requested window.
    const { c, calls } = client([
      {
        results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        paging: { nextPage: '/learn/api/v1/calendars/calendarItems?limit=100&until=2026-10-28&offset=0' },
      },
      { results: [{ id: 'from-2022' }] },
    ]);

    const rows = await c.paginate('/learn/api/v1/calendars/calendarItems', {
      limit: 200,
      query: { since: '2026-10-07', until: '2026-10-28' },
    });

    assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.equal(calls.length, 1);
  });

  test('still follows links that advance', async () => {
    const { c, calls } = client([
      { results: [{ id: 1 }, { id: 2 }], paging: { nextPage: '/x?limit=2&offset=2' } },
      { results: [{ id: 3 }, { id: 4 }], paging: { nextPage: '/x?limit=2&offset=4' } },
      { results: [{ id: 5 }], paging: { nextPage: '' } },
    ]);

    const rows = await c.paginate('/x', { limit: 10 });

    assert.deepEqual(rows.map((r) => (r as { id: number }).id), [1, 2, 3, 4, 5]);
    assert.deepEqual(calls.map((x) => x.path), ['/x', '/x?limit=2&offset=2', '/x?limit=2&offset=4']);
    assert.equal(calls[1]?.query, undefined, 'a followed link carries its own query');
  });

  test('follows a link with no offset at all, as before', async () => {
    const { c, calls } = client([
      { results: [{ id: 1 }], paging: { nextPage: '/x?cursor=abc' } },
      { results: [{ id: 2 }], paging: { nextPage: '' } },
    ]);

    assert.equal((await c.paginate('/x', { limit: 10 })).length, 2);
    assert.equal(calls.length, 2);
  });
});
