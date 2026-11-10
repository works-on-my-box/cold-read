import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_QUESTIONS,
  MAX_QUESTIONS,
  validateQuestions,
  parseAnswers,
  submitRefusal,
  storageToText,
  newRunId,
  isRunId,
  isPageId,
} from '../src/logic.js';

test('validateQuestions accepts the handoff set and trims values', () => {
  assert.deepEqual(validateQuestions(HANDOFF_QUESTIONS), { questions: HANDOFF_QUESTIONS });
  const { questions } = validateQuestions([{ id: 'q1', text: '  Who owns it?  ', expected: ' Priya ' }]);
  assert.deepEqual(questions, [{ id: 'q1', text: 'Who owns it?', expected: 'Priya' }]);
});

test('validateQuestions rejects bad lists', () => {
  assert.ok(validateQuestions([]).error);
  assert.ok(validateQuestions('nope').error);
  const tooMany = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ id: `q${i}`, text: 'x' }));
  assert.ok(validateQuestions(tooMany).error);
  assert.ok(validateQuestions([{ id: 'Q 1', text: 'x' }]).error, 'id with a space and capital');
  assert.ok(validateQuestions([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }]).error, 'duplicate id');
  assert.ok(validateQuestions([{ id: 'a', text: '   ' }]).error, 'empty question');
  assert.ok(validateQuestions([{ id: 'a', text: 'x'.repeat(301) }]).error, 'question too long');
  assert.ok(validateQuestions([{ id: 'a', text: 'x', expected: 'y'.repeat(1001) }]).error, 'expected too long');
});

test('parseAnswers reads the JSON the agent is asked for', () => {
  const raw = JSON.stringify([
    { q: 1, answer: 'Quote is drafted.', quote: 'Quote drafted' },
    { q: 2, answer: 'NOT STATED', quote: '' },
  ]);
  const { answers, missing } = parseAnswers(raw, 3);
  assert.deepEqual(answers, [
    { q: 1, answer: 'Quote is drafted.', quote: 'Quote drafted', notStated: false },
    { q: 2, answer: 'NOT STATED', quote: '', notStated: true },
  ]);
  assert.deepEqual(missing, [3]);
});

test('parseAnswers accepts a code fence, an object wrapper and string numbers', () => {
  const fenced = '```json\n[{"q": "1", "answer": "Yes", "quote": "sent"}]\n```';
  assert.equal(parseAnswers(fenced, 1).answers[0].answer, 'Yes');
  const wrapped = { answers: [{ q: 1, answer: 'Yes', quote: 'sent' }] };
  assert.equal(parseAnswers(wrapped, 1).answers.length, 1);
});

test('parseAnswers keeps a note after NOT STATED and flags it in any case', () => {
  const { answers } = parseAnswers([{ q: 1, answer: 'Not stated. The page names no owner.', quote: '' }], 1);
  assert.equal(answers[0].notStated, true);
  assert.equal(answers[0].answer, 'Not stated. The page names no owner.');
});

test('parseAnswers drops out-of-range, duplicate and empty answers', () => {
  const { answers, missing } = parseAnswers(
    [
      { q: 0, answer: 'zero' },
      { q: 4, answer: 'four' },
      { q: 1, answer: 'first' },
      { q: 1, answer: 'second' },
      { q: 2, answer: '   ' },
    ],
    3,
  );
  assert.deepEqual(answers.map((a) => a.answer), ['first']);
  assert.deepEqual(missing, [2, 3]);
});

test('parseAnswers falls back to "Q1: answer" lines', () => {
  const { answers, missing } = parseAnswers('Q1: Drafted in the Sales folder.\nQ3: NOT STATED. No owner named.', 3);
  assert.deepEqual(answers.map((a) => [a.q, a.notStated]), [[1, false], [3, true]]);
  assert.equal(answers[0].quote, '');
  assert.deepEqual(missing, [2]);
});

test('submitRefusal: one run takes answers once, from the person who started it', () => {
  const ids = { pageId: '1', runId: 'abc12345', accountId: 'u1' };
  assert.match(submitRefusal(undefined, ids), /no cold read/);
  assert.match(submitRefusal({ status: 'answered', startedBy: 'u1' }, ids), /already saved/);
  assert.match(submitRefusal({ status: 'reading', startedBy: 'u2' }, ids), /another person/);
  assert.equal(submitRefusal({ status: 'reading', startedBy: 'u1' }, ids), null);
});

test('parseAnswers reports garbage as an error', () => {
  assert.ok(parseAnswers('not json', 2).error);
  assert.ok(parseAnswers('{"q": 1}', 2).error);
  assert.ok(parseAnswers('[]', 2).error);
});

test('storageToText turns storage format into lines', () => {
  const xhtml = '<h1>Acme</h1><p>Quote&nbsp;sent &amp; signed</p><ul><li>one</li><li>two</li></ul>';
  assert.equal(storageToText(xhtml), 'Acme\nQuote sent & signed\none\ntwo');
  assert.equal(storageToText(undefined), '');
});

test('run IDs are valid KVS key parts and sort by time', () => {
  const a = newRunId(Date.UTC(2026, 10, 10));
  const b = newRunId(Date.UTC(2026, 10, 11));
  assert.ok(isRunId(a) && isRunId(b));
  assert.ok(a < b);
  assert.ok(isPageId('3964929'));
  assert.ok(!isPageId('39649x'));
});
