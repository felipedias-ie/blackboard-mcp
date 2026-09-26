import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { gradeHasSubmission, rebucketSubmitted, type BbTodoItem } from '../dist/client/index.js';

describe('todo submission annotation', () => {
  test('gradeHasSubmission detects attempts and awaiting-grade rows', () => {
    assert.equal(gradeHasSubmission({ lastAttemptId: '_1_1' }), true);
    assert.equal(gradeHasSubmission({ firstAttemptId: '_1_1' }), true);
    assert.equal(gradeHasSubmission({ submissionStatus: { status: 'NEEDS_GRADING' } }), true);
    assert.equal(gradeHasSubmission({}), false);
    // A manually graded row with no student attempt is not a submission.
    assert.equal(gradeHasSubmission({ manualScore: 10, status: 'GRADED' }), false);
  });

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
