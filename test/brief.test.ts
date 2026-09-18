import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assignmentBriefOf, extractLinks, plainText } from '../dist/lib/brief.js';

describe('assignment brief extraction', () => {
  // Shape verified against a live tenant: everything a student needs sits
  // several levels inside contentDetail, and `body` is empty on these items.
  const testLink = {
    id: '_1_1',
    title: 'Structural Patterns Exercise',
    contentHandler: 'resource/x-bb-asmt-test-link',
    body: { rawText: '', displayText: '' },
    contentDetail: {
      'resource/x-bb-asmt-test-link': {
        test: {
          assessment: {
            title: 'Structural Patterns Exercise',
            instructions: {
              rawText: '<p>Fork https://github.com/example/sdd-structural-patterns and push your work.</p>',
              displayText: '<div><p>Fork https://github.com/example/sdd-structural-patterns and push your work.</p></div>',
            },
          },
          deploymentSettings: {
            allowTextSubmission: true,
            allowFileSubmission: false,
            attemptCount: -1,
            isLateAttemptCreationDisallowed: true,
            isScoreShown: false,
            isWebcamRequired: true,
            // Must never be surfaced: it is the viewer's own IP.
            restrictLocation: { userIpAddress: '203.0.113.7' },
          },
          gradingColumn: { dueDate: '2026-09-18T20:00:00.000Z', possible: 100 },
        },
      },
    },
  };

  test('reads instructions that are unreachable from body', () => {
    const b = assignmentBriefOf(testLink as never);
    assert.ok(b, 'should produce a brief');
    assert.match(b.instructionsText ?? '', /Fork .* and push your work/);
  });

  test('extracts the repo link, which is often the whole assignment', () => {
    const b = assignmentBriefOf(testLink as never);
    assert.deepEqual(b?.links, ['https://github.com/example/sdd-structural-patterns']);
  });

  test('surfaces the settings needed before starting', () => {
    const b = assignmentBriefOf(testLink as never)!;
    assert.equal(b.allowsText, true);
    assert.equal(b.allowsFiles, false);
    assert.equal(b.dueDate, '2026-09-18T20:00:00.000Z');
    assert.equal(b.pointsPossible, 100);
    assert.equal(b.lateAttemptsBlocked, true);
    assert.equal(b.requiresWebcam, true);
    assert.equal(b.showsScore, false);
  });

  test('normalises the unlimited-attempts sentinel', () => {
    // Blackboard sends -1, which reads as nonsense to a user.
    assert.equal(assignmentBriefOf(testLink as never)?.attemptsAllowed, 'unlimited');
  });

  test('never surfaces the viewer IP from restrictLocation', () => {
    const serialised = JSON.stringify(assignmentBriefOf(testLink as never));
    assert.doesNotMatch(serialised, /203\.0\.113\.7/);
    assert.doesNotMatch(serialised, /userIpAddress/);
  });

  test('returns null for an item that is not an assignment', () => {
    assert.equal(
      assignmentBriefOf({
        id: '_2_1',
        contentHandler: 'resource/x-bb-folder',
        contentDetail: { 'resource/x-bb-folder': { isFolder: true } },
      } as never),
      null,
    );
    assert.equal(assignmentBriefOf({ id: '_3_1' } as never), null);
  });
});

describe('link extraction', () => {
  test('strips trailing punctuation and de-duplicates', () => {
    assert.deepEqual(
      extractLinks('See https://a.example/x, and https://a.example/x again. Also https://b.example.'),
      ['https://a.example/x', 'https://b.example'],
    );
  });

  test('returns an empty array for no input', () => {
    assert.deepEqual(extractLinks(undefined), []);
    assert.deepEqual(extractLinks('no links here'), []);
  });
});

describe('plainText accessor', () => {
  test('reads a Blackboard rich-text object rather than stringifying it', () => {
    // String(field) on these yields "[object Object]", which is the trap.
    assert.equal(plainText({ rawText: '<p>hello</p>', displayText: '<div><p>hello</p></div>' }), 'hello');
    assert.equal(plainText({ rawText: '<p>raw only</p>' }), 'raw only');
  });

  test('tolerates strings, undefined and null', () => {
    assert.equal(plainText('<p>x</p>'), 'x');
    assert.equal(plainText(undefined), '');
    assert.equal(plainText(null), '');
  });
});
