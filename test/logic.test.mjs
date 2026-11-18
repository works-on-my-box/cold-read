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
  relatedJql,
  adfToText,
  findingsIssue,
  statusAdvice,
  bylineStatus,
  mergeSuggested,
  pageState,
  storageToText,
  newRunId,
  isRunId,
  isPageId,
  replacesLastRun,
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

test('runRefusal holds the order: answers once, then findings once', () => {
  const ids = { pageId: '1', runId: 'abc12345' };
  const run = (status, extra = {}) => ({ status, questions: [{ id: 'h1', text: 'Q', expected: 'E' }], ...extra });
  assert.match(runRefusal(undefined, 'answers', ids), /no cold read/);
  assert.equal(runRefusal(run('reading'), 'answers', ids), null);
  assert.match(runRefusal(run('answered'), 'answers', ids), /already saved/);
  // Runs saved by earlier versions may still hold startedBy: it is ignored.
  assert.equal(runRefusal(run('reading', { startedBy: 'u2' }), 'answers', ids), null);
  assert.match(runRefusal(run('reading'), 'findings', ids), /answers .* first/);
  assert.equal(runRefusal(run('answered'), 'findings', ids), null);
  assert.match(runRefusal(run('checked'), 'findings', ids), /Findings .* already saved/);
});

test('runRefusal: without expected answers the findings need a warm read first', () => {
  const ids = { pageId: '1', runId: 'abc12345' };
  const noExpected = { status: 'answered', questions: [{ id: 'h1', text: 'Q', expected: '' }] };
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

test('storageToText keeps code blocks, mentions, table cells and macro titles apart', () => {
  // How Confluence stores a runbook: a code macro (CDATA), a mention, a table, a warning with a title.
  const xhtml =
    '<p>Owner: <ac:link><ri:user ri:account-id="5b10ac8d82e05b22cc7d4ef5" /></ac:link></p>' +
    '<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">bash</ac:parameter>' +
    '<ac:plain-text-body><![CDATA[kubectl rollout undo deploy/api\ncat <<EOF > /tmp/a && echo "a&b"\nEOF]]></ac:plain-text-body></ac:structured-macro>' +
    '<table><tbody><tr><th><p>Step</p></th><th><p>Owner</p></th></tr><tr><td><p>Roll back</p></td><td><p>Priya</p></td></tr></tbody></table>' +
    '<ac:structured-macro ac:name="warning"><ac:parameter ac:name="title">Warn</ac:parameter>' +
    '<ac:rich-text-body><p>Do not restart the queue.</p></ac:rich-text-body></ac:structured-macro>';
  assert.equal(
    storageToText(xhtml),
    'Owner: @user\n' +
      'kubectl rollout undo deploy/api\ncat <<EOF > /tmp/a && echo "a&b"\nEOF\n' +
      'Step | Owner\nRoll back | Priya\n' +
      'Warn\nDo not restart the queue.',
  );
});

test('storageToText keeps inline macros, links, tasks and dates in their sentence', () => {
  const jira = '<p>Blocked by <ac:structured-macro ac:name="jira" ac:schema-version="1"><ac:parameter ac:name="server">System Jira</ac:parameter>' +
    '<ac:parameter ac:name="key">OPS-123</ac:parameter></ac:structured-macro> until Friday.</p>';
  assert.equal(storageToText(jira), 'Blocked by OPS-123 until Friday.');
  const jql = '<p>Open items:</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="server">System Jira</ac:parameter>' +
    '<ac:parameter ac:name="jqlQuery">project = OPS AND status != Done</ac:parameter></ac:structured-macro><p>Next: deploy.</p>';
  assert.equal(storageToText(jql), 'Open items:\nJira issues: project = OPS AND status != Done\nNext: deploy.');
  const status = '<table><tbody><tr><td><p>Rotate keys</p></td><td><p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter>' +
    '<ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro></p></td><td><p>Priya</p></td></tr></tbody></table>';
  assert.equal(storageToText(status), 'Rotate keys | DONE | Priya');
  const wrapped = '<table><tbody><tr><td><div class="content-wrapper"><p>Rollback</p></div></td><td><div class="content-wrapper">' +
    '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[./rollback.sh --to v41]]></ac:plain-text-body></ac:structured-macro></div></td>' +
    '<td><p>Sam</p></td></tr></tbody></table>';
  assert.equal(storageToText(wrapped), 'Rollback | ./rollback.sh --to v41 | Sam');
  const emptyFirst = '<p>On-call matrix:</p><table><tbody><tr><th><p /></th><th><p>Mon</p></th></tr><tr><td><p>20.11</p></td><td><p>Sam</p></td></tr>' +
    '<tr><td><p /></td><td><p>Priya</p></td></tr></tbody></table><p>Jump <ac:link ac:anchor="top" /> to the top.</p>';
  assert.equal(storageToText(emptyFirst), 'On-call matrix:\n | Mon\n20.11 | Sam\n | Priya\nJump  to the top.');
  assert.equal(storageToText('<p>Columns:</p><p> | name | role</p>'), 'Columns:\n | name | role');
  const link = '<p>Follow <ac:link><ri:page ri:content-title="Rollback runbook" /><ac:plain-text-link-body><![CDATA[the rollback runbook]]></ac:plain-text-link-body></ac:link> first, ' +
    'then <ac:link><ri:page ri:content-title="Release notes" /></ac:link>, <ac:link><ri:attachment ri:filename="plan.pdf" /></ac:link> and ' +
    '<ac:link><ri:user ri:account-id="5b10ac8d82e05b22cc7d4ef5" /><ac:plain-text-link-body><![CDATA[Priya]]></ac:plain-text-link-body></ac:link>.</p>';
  assert.equal(storageToText(link), 'Follow the rollback runbook first, then Release notes, plan.pdf and Priya.');
  const selfClosing = '<ac:structured-macro ac:name="code"><ac:parameter ac:name="theme" /><ac:plain-text-body><![CDATA[make deploy]]></ac:plain-text-body></ac:structured-macro>' +
    '<p>Owner: Sam. Do not run twice.</p><ac:structured-macro ac:name="info"><ac:parameter ac:name="icon">true</ac:parameter><ac:rich-text-body><p>Window: Fri.</p></ac:rich-text-body></ac:structured-macro>';
  assert.equal(storageToText(selfClosing), 'make deploy\nOwner: Sam. Do not run twice.\nWindow: Fri.');
  const tasks = '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Rotate the keys</ac:task-body></ac:task>' +
    '<ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Deploy to prod</ac:task-body></ac:task></ac:task-list>' +
    '<p>Cut-over: <time datetime="2026-11-20" />, <ac:emoticon ac:name="tick" /> tested.</p><pre>make deploy</pre><p>Pipe it on: dmesg |</p><p>Literal &amp;lt;br&amp;gt; stays.</p>';
  assert.equal(storageToText(tasks), '[x] Rotate the keys\n[ ] Deploy to prod\nCut-over: 2026-11-20, (tick) tested.\nmake deploy\nPipe it on: dmesg |\nLiteral &lt;br&gt; stays.');
  const code = '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[    indented()\n\n\n\nafter_blank_lines()]]></ac:plain-text-body></ac:structured-macro>';
  assert.equal(storageToText(code), '    indented()\n\n\n\nafter_blank_lines()');
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
  assert.match(statusAdvice(checked([{ verdict: 'A' }]), 3), /Ask the page owner to fix them/);
  const tracked = { ...checked([{ verdict: 'A' }]), jira: { key: 'REN-7' } };
  assert.match(statusAdvice(tracked, 3), /The fix is tracked in Jira issue REN-7\./);
});

test('relatedJql searches Jira issues by the same terms, newest first, without Cold Read\'s own issues', () => {
  const own = ' AND (labels IS EMPTY OR labels NOT IN ("cold-read"))';
  assert.equal(relatedJql(['Acme', 'renewal']), `(text ~ "Acme" OR text ~ "renewal")${own} ORDER BY updated DESC`);
  assert.equal(
    relatedJql(['Acme', 'renewal', 'Priya'], 2),
    `((text ~ "Acme" AND text ~ "renewal") OR (text ~ "Acme" AND text ~ "Priya") OR (text ~ "renewal" AND text ~ "Priya"))${own} ORDER BY updated DESC`,
  );
  assert.equal(relatedJql(['Acme'], 2), `(text ~ "Acme")${own} ORDER BY updated DESC`);
});

test('replacesLastRun: only a finished run becomes the last one, and not an older one', () => {
  const run = (startedAt, status = 'checked') => ({ runId: startedAt, startedAt, status });
  assert.equal(replacesLastRun(undefined, run('2026-11-12T07:00:00Z')), true);
  assert.equal(replacesLastRun(run('2026-11-12T07:00:00Z'), run('2026-11-12T07:05:00Z')), true);
  // A run that started earlier and finished later does not hide the newer result.
  assert.equal(replacesLastRun(run('2026-11-12T07:05:00Z'), run('2026-11-12T07:00:00Z')), false);
  // Unfinished runs never replace a result: an abandoned packet must not hide the A findings.
  assert.equal(replacesLastRun(run('2026-11-12T07:00:00Z'), run('2026-11-12T07:05:00Z', 'reading')), false);
  assert.equal(replacesLastRun(undefined, run('2026-11-12T07:05:00Z', 'answered')), false);
});

test('adfToText reads Jira descriptions and comments', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Quote sent to ' }, { type: 'mention', attrs: { text: '@Dana Ruiz' } }, { type: 'text', text: ' on Nov 7.' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Total $48,000' }] }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
    ],
  };
  assert.equal(adfToText(doc), 'Quote sent to @Dana Ruiz on Nov 7.\nTotal $48,000\nline one\nline two');
  assert.equal(adfToText(undefined), '');
  assert.equal(adfToText({ type: 'doc', content: [] }), '');
});

test('findingsIssue lists only the A findings of a checked run, with a link to the page', () => {
  const run = {
    runId: 'mwa912mst2v1',
    status: 'checked',
    title: 'Handoff: Acme renewal',
    pageVersion: 4,
    checkedAt: '2026-11-12T03:00:00.000Z',
    questions: [{ id: 'h1', text: 'Where does the work stand?' }, { id: 'h2', text: 'What must not be done again?' }],
    findings: [
      { q: 1, verdict: 'C', note: 'Add the date.' },
      { q: 2, verdict: 'A', note: 'The quote was already sent on Nov 7; the page says to send it.' },
    ],
  };
  const issue = findingsIssue(run, { pageTitle: 'Handoff: Acme renewal', pageUrl: 'https://x.atlassian.net/wiki/x/AYA8' });
  assert.equal(issue.summary, 'Cold Read: 1 class A finding on "Handoff: Acme renewal"');
  assert.equal(issue.count, 1);
  const [intro, list, outro] = issue.description.content;
  assert.deepEqual(intro.content[1].marks, [{ type: 'link', attrs: { href: 'https://x.atlassian.net/wiki/x/AYA8' } }]);
  assert.equal(list.content.length, 1);
  assert.equal(list.content[0].content[0].content[0].text, 'Question 2: What must not be done again?');
  assert.equal(list.content[0].content[0].content[1].text, ' The quote was already sent on Nov 7; the page says to send it.');
  assert.match(outro.content[0].text, /Run mwa912mst2v1, checked 2026-11-12\./);
  assert.ok(findingsIssue({ ...run, findings: [{ q: 1, verdict: 'C' }] }, {}).error, 'no A findings');
  assert.ok(findingsIssue({ ...run, status: 'answered' }, {}).error, 'run not finished');
  const two = findingsIssue({ ...run, findings: [{ q: 1, verdict: 'A' }, { q: 2, verdict: 'A' }] }, { pageTitle: 'P' });
  assert.equal(two.summary, 'Cold Read: 2 class A findings on "P"');
});

test('bylineStatus shows the latest result under the page title', () => {
  const checked = (findings, pageVersion = 2) => ({ status: 'checked', pageVersion, findings });
  assert.equal(bylineStatus(undefined, 2).title, 'Cold Read');
  assert.equal(bylineStatus({ status: 'reading', pageVersion: 2 }, 2).title, 'Cold Read');
  assert.equal(bylineStatus(checked([{ verdict: 'A' }], 1), 2).title, 'Cold Read · page changed');
  assert.equal(bylineStatus(checked([{ verdict: 'A' }, { verdict: 'A' }, { verdict: 'C' }]), 2).title, 'Cold Read · 2 A');
  assert.equal(bylineStatus(checked([{ verdict: 'B' }, { verdict: 'C' }]), 2).title, 'Cold Read · 2 to fix');
  assert.equal(bylineStatus(checked([{ verdict: 'match' }]), undefined).title, 'Cold Read · clear');
});

test('mergeSuggested replaces the default set but keeps the owner\'s questions', () => {
  const now = Date.UTC(2026, 10, 10);
  const fromDefault = mergeSuggested(HANDOFF_QUESTIONS, true, '["Who is on call?", "Where is the rollback script?"]', now);
  assert.deepEqual(fromDefault.questions.map((q) => q.text), ['Who is on call?', 'Where is the rollback script?']);
  assert.equal(validateQuestions(fromDefault.questions).error, undefined);

  const own = [{ id: 'q1', text: 'Who is on call?', expected: 'Mia' }];
  const merged = mergeSuggested(own, false, '1. Who is on call?\n2. Where is the rollback script?', now);
  assert.deepEqual(merged.questions.map((q) => [q.text, q.expected]), [['Who is on call?', 'Mia'], ['Where is the rollback script?', '']]);
  assert.equal(merged.added, 1);

  const full = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, text: `Q${i}?`, expected: '' }));
  assert.ok(mergeSuggested(full, false, '["New?"]', now).error);
});

test('pageState labels a page for the space summary', () => {
  assert.equal(pageState(undefined, 1).key, 'none');
  assert.equal(pageState({ status: 'answered', pageVersion: 1 }, 1).key, 'unfinished');
  assert.equal(pageState({ status: 'checked', pageVersion: 1, findings: [] }, 2).key, 'changed');
  assert.deepEqual(pageState({ status: 'checked', pageVersion: 2, findings: [{ verdict: 'A' }, { verdict: 'C' }] }, 2), { key: 'A', label: '1 A', a: 1, b: 0, c: 1 });
  assert.equal(pageState({ status: 'checked', pageVersion: 2, findings: [{ verdict: 'match' }] }, 2).label, 'Clear');
});
