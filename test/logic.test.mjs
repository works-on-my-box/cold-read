import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_QUESTIONS,
  MAX_QUESTIONS,
  validateQuestions,
  parseAnswers,
  runRefusal,
  expectedOf,
  parseFindings,
  searchTerms,
  relatedCql,
  statusAdvice,
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

test('runRefusal holds the order: answers once, then findings once, same person', () => {
  const ids = { pageId: '1', runId: 'abc12345', accountId: 'u1' };
  const run = (status, extra = {}) => ({ status, startedBy: 'u1', questions: [{ id: 'h1', text: 'Q', expected: 'E' }], ...extra });
  assert.match(runRefusal(undefined, 'answers', ids), /no cold read/);
  assert.equal(runRefusal(run('reading'), 'answers', ids), null);
  assert.match(runRefusal(run('answered'), 'answers', ids), /already saved/);
  assert.match(runRefusal({ ...run('reading'), startedBy: 'u2' }, 'answers', ids), /another person/);
  assert.match(runRefusal(run('reading'), 'findings', ids), /answers .* first/);
  assert.equal(runRefusal(run('answered'), 'findings', ids), null);
  assert.match(runRefusal(run('checked'), 'findings', ids), /Findings .* already saved/);
});

test('runRefusal: without expected answers the findings need a warm read first', () => {
  const ids = { pageId: '1', runId: 'abc12345', accountId: 'u1' };
  const noExpected = { status: 'answered', startedBy: 'u1', questions: [{ id: 'h1', text: 'Q', expected: '' }] };
  assert.equal(runRefusal(noExpected, 'warm', ids), null);
  assert.match(runRefusal(noExpected, 'findings', ids), /get-warm-read-packet/);
  assert.equal(runRefusal({ ...noExpected, warm: { sources: [] } }, 'findings', ids), null);
  const withExpected = { ...noExpected, questions: [{ id: 'h1', text: 'Q', expected: 'E' }] };
  assert.match(runRefusal(withExpected, 'warm', ids), /not needed/);
});

test('searchTerms and relatedCql build a safe query from the title', () => {
  assert.deepEqual(searchTerms('Handoff: Acme renewal (Alex to Priya)'), ['Acme', 'renewal', 'Alex', 'Priya']);
  assert.deepEqual(searchTerms('"; DROP --'), ['DROP']);
  assert.equal(
    relatedCql('3964929', ['Acme', 'renewal']),
    'type = page AND id != 3964929 AND (text ~ "Acme" OR text ~ "renewal")',
  );
  assert.equal(
    relatedCql('1', ['Acme', 'renewal', 'Priya'], 2),
    'type = page AND id != 1 AND ((text ~ "Acme" AND text ~ "renewal") OR (text ~ "Acme" AND text ~ "Priya") OR (text ~ "renewal" AND text ~ "Priya"))',
  );
  assert.equal(relatedCql('1', ['Acme'], 2), 'type = page AND id != 1 AND (text ~ "Acme")');
});

test('expectedOf lists only questions with an expected answer, by run number', () => {
  const run = { questions: [{ id: 'h1', text: 'Where?', expected: 'Sent' }, { id: 'h2', text: 'Next?', expected: '' }, { id: 'q9', text: 'Amount?', expected: '$48,000' }] };
  assert.deepEqual(expectedOf(run), [
    { q: 1, question: 'Where?', expected: 'Sent' },
    { q: 3, question: 'Amount?', expected: '$48,000' },
  ]);
});

test('parseFindings keeps verdicts for allowed questions only', () => {
  const raw = JSON.stringify([
    { q: 1, verdict: 'A', note: 'Say the quote was sent on Nov 7.' },
    { q: 2, verdict: 'match', note: '' },
    { q: 3, verdict: 'c - not covered', note: 'Name who is waiting.' },
    { q: 4, verdict: 'B', note: 'not allowed' },
    { q: 1, verdict: 'B', note: 'duplicate' },
    { q: 2, verdict: 'X', note: 'bad verdict' },
  ]);
  const { findings } = parseFindings(raw, new Set([1, 2, 3]));
  assert.deepEqual(findings.map((f) => [f.q, f.verdict]), [[1, 'A'], [2, 'match'], [3, 'C']]);
  assert.ok(parseFindings('nonsense', new Set([1])).error);
  assert.ok(parseFindings('[{"q": 5, "verdict": "A"}]', new Set([1])).error);
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

test('statusAdvice says whether the page is safe to act on', () => {
  const checked = (findings, pageVersion = 3) => ({ status: 'checked', pageVersion, findings });
  assert.match(statusAdvice(undefined, 3), /No cold read yet/);
  assert.match(statusAdvice(checked([], 2), 3), /changed after the last cold read \(version 2, now 3\)/);
  assert.match(statusAdvice({ status: 'answered', pageVersion: 3 }, 3), /did not finish/);
  assert.match(statusAdvice(checked([{ verdict: 'A' }, { verdict: 'C' }]), 3), /Do not act .* 1 class A/);
  assert.match(statusAdvice(checked([{ verdict: 'B' }, { verdict: 'match' }]), 3), /no class A/);
});
