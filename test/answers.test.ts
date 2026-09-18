import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAnswer, describeOptions } from '../dist/lib/answers.js';

const opt = (t: string, id: string) => ({ id, answerText: { rawText: t, displayText: `<div>${t}</div>` } });

const choice = (type: string, single = false) => ({
  questionType: type,
  question: {
    questionType: type,
    singleCorrectAnswer: single,
    answers: [opt('Alpha', 'a1'), opt('Beta', 'a2'), opt('Gamma', 'a3'), opt('Delta', 'a4')],
  },
});

describe('choice answers', () => {
  test('resolves 1-based option numbers', () => {
    const r = encodeAnswer(choice('multipleanswer') as never, [1, 3]);
    assert.deepEqual(r.givenAnswer, [true, false, true, false]);
    assert.match(r.interpretation, /1\. Alpha/);
    assert.match(r.interpretation, /3\. Gamma/);
  });

  test('resolves a single number without an array', () => {
    assert.deepEqual(encodeAnswer(choice('multiplechoice', true) as never, 2).givenAnswer, [
      false, true, false, false,
    ]);
  });

  test('resolves exact and partial option text', () => {
    assert.deepEqual(encodeAnswer(choice('multipleanswer') as never, 'Beta').givenAnswer, [
      false, true, false, false,
    ]);
    assert.deepEqual(encodeAnswer(choice('multipleanswer') as never, ['gam']).givenAnswer, [
      false, false, true, false,
    ]);
  });

  test('resolves option ids', () => {
    assert.deepEqual(encodeAnswer(choice('multipleanswer') as never, 'a4').givenAnswer, [
      false, false, false, true,
    ]);
  });

  test('accepts an already-built boolean mask', () => {
    const mask = [true, false, false, true];
    assert.deepEqual(encodeAnswer(choice('multipleanswer') as never, mask).givenAnswer, mask);
  });

  test('refuses several selections on a single-answer question', () => {
    assert.throws(
      () => encodeAnswer(choice('multiplechoice', true) as never, [1, 2]),
      /accepts one answer/,
    );
  });

  test('refuses an out-of-range option, naming the range', () => {
    assert.throws(() => encodeAnswer(choice('multipleanswer') as never, 9), /out of range/);
  });

  test('refuses ambiguous text rather than guessing', () => {
    const q = {
      questionType: 'multipleanswer',
      question: { questionType: 'multipleanswer', answers: [opt('Integration by parts', 'x'), opt('Integration by substitution', 'y')] },
    };
    assert.throws(() => encodeAnswer(q as never, 'integration'), /matches 2 options/);
  });

  test('lists the options when nothing matches', () => {
    // The guidance lives in `hint`, which is what a tool surfaces via
    // describe(); assert.throws only inspects `message`.
    try {
      encodeAnswer(choice('multipleanswer') as never, 'Epsilon');
      assert.fail('should have thrown');
    } catch (err) {
      const e = err as { message: string; hint?: string; describe?: () => string };
      assert.match(e.message, /No option matches "Epsilon"/);
      assert.match(e.hint ?? '', /1\. Alpha/);
      assert.match(e.hint ?? '', /4\. Delta/);
      // What the caller actually sees must carry the options.
      assert.match(e.describe?.() ?? '', /Alpha/);
    }
  });
});

describe('true/false answers', () => {
  const tf = {
    questionType: 'truefalse',
    question: { questionType: 'truefalse', singleCorrectAnswer: true, answers: [opt('True', 't'), opt('False', 'f')] },
  };

  test('maps booleans onto the labelled options', () => {
    assert.deepEqual(encodeAnswer(tf as never, true).givenAnswer, [true, false]);
    assert.deepEqual(encodeAnswer(tf as never, false).givenAnswer, [false, true]);
  });

  test('maps booleans by label even when the order is reversed', () => {
    const reversed = {
      questionType: 'truefalse',
      question: { questionType: 'truefalse', answers: [opt('False', 'f'), opt('True', 't')] },
    };
    assert.deepEqual(encodeAnswer(reversed as never, true).givenAnswer, [false, true]);
  });
});

describe('text answers', () => {
  const essay = { questionType: 'essay', question: { questionType: 'essay' } };

  test('wraps plain text as rich text', () => {
    const r = encodeAnswer(essay as never, 'Because f is continuous.');
    assert.deepEqual(r.givenAnswer, {
      rawText: '<p>Because f is continuous.</p>',
      displayText: '<p>Because f is continuous.</p>',
    });
  });

  test('passes existing markup through unwrapped', () => {
    const r = encodeAnswer(essay as never, '<p>Already <b>marked up</b></p>');
    assert.match(JSON.stringify(r.givenAnswer), /Already <b>marked up<\/b>/);
  });

  test('escapes characters that would break the markup', () => {
    const r = encodeAnswer(essay as never, 'a < b && c > d');
    assert.match(JSON.stringify(r.givenAnswer), /a &lt; b &amp;&amp; c &gt; d/);
  });
});

describe('numeric answers', () => {
  const numeric = { questionType: 'numeric', question: { questionType: 'numeric' } };

  test('sends a string, which is the observed wire shape', () => {
    assert.equal(encodeAnswer(numeric as never, 42).givenAnswer, '42');
    assert.equal(encodeAnswer(numeric as never, '3.14').givenAnswer, '3.14');
  });

  test('refuses input that is not a number', () => {
    assert.throws(() => encodeAnswer(numeric as never, true), /takes a number/);
  });
});

describe('unrecognised question types', () => {
  test('passes the value through and flags that it did', () => {
    const r = encodeAnswer({ questionType: 'jumbledsentence', question: {} } as never, { a: 1 });
    assert.equal(r.passthrough, true);
    assert.deepEqual(r.givenAnswer, { a: 1 });
    assert.match(r.interpretation, /unrecognised type "jumbledsentence"/);
  });
});

describe('option listing', () => {
  test('numbers options and strips markup', () => {
    assert.equal(describeOptions(choice('multipleanswer').question as never),
      '1. Alpha\n2. Beta\n3. Gamma\n4. Delta');
  });
});
