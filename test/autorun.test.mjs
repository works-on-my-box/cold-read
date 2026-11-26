import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAutoRun } from '../src/autorun.js';
import { makeSpend } from '../src/spend.js';
import { expectedOf, replacesLastRun, interruptedRun, PRICES, callCost, UNAVAILABLE, PAGE_CHARS, WARM_SOURCES, WARM_SOURCE_CHARS, WARM_ANSWERS_RULES, CONFLICT_RULES, STEP_TAKEN, HIDDEN_NOTE } from '../src/logic.js';

const PAGE = { id: '3964929', title: 'Handoff: Acme renewal (Alex to Priya)', version: 4, text: 'Priya sends the quote to Acme procurement by Nov 14.' };
const EXPECTED = [
  { id: 'h1', text: 'Where does the work stand right now?', expected: 'The quote went to Acme on Nov 7.' },
  { id: 'h2', text: 'What is the single next step, and who does it?', expected: 'Priya follows up with Dana Ruiz.' },
];
const NO_EXPECTED = EXPECTED.map(({ id, text }) => ({ id, text, expected: '' }));
const toolReply = (args) => ({ data: typeof args === 'string' ? JSON.parse(args) : args, ms: 5, usage: {} });
const ANSWERS = toolReply({ answers: [{ q: 1, answer: 'The quote is drafted.', quote: 'drafted' }, { q: 2, answer: 'NOT STATED', quote: '' }] });
const FINDINGS = toolReply({ findings: [{ q: 1, verdict: 'A', note: 'Say the quote was sent.' }, { q: 2, verdict: 'C', note: 'Name the follow-up.' }] });

// An in-memory Key-Value Store for src/spend.js: get, set (with keyPolicy FAIL_IF_EXISTS), delete, batchGet.
// Each call waits a tick, so calls of runs going at the same time interleave as they would in the store.
function fakeKvs() {
  const data = new Map();
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    data,
    async get(key) {
      await tick();
      return copy(data.get(key));
    },
    async set(key, value, options) {
      await tick();
      if (options?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) throw Object.assign(new Error('The key exists'), { code: 'KEY_ALREADY_EXISTS' });
      data.set(key, copy(value));
    },
    async delete(key) {
      await tick();
      data.delete(key);
    },
    async batchGet(items) {
      await tick();
      return { successfulKeys: items.filter(({ key }) => data.has(key)).map(({ key }) => ({ key, value: copy(data.get(key)) })), failedKeys: [] };
    },
  };
}

const OPEN = { BLOCKED_CLOUD_IDS: [], BUTTON_ENABLED: true, BUTTON_EXPIRES: '2027-02-20T00:00:00Z' };
const SITE = { cloudId: 'c0ffee00-site', installContext: 'ari:cloud:confluence::site/c0ffee00-site', environmentType: 'DEVELOPMENT' };

// A fake world: the page, an in-memory store with the same record rules as store.js, the spend counters of
// src/spend.js and the step marks of claimStep on a fake KVS, and scripted model replies; a reply costs its usage at
// the price pickModel gives. questions: the page questions, or a function that gives them for each read.
// modelDelayMs: the fake model answers only after this wait, and calls waiting at the same time are counted.
// flag: what the feature flag says ({ on, reason }), null when there is none to read.
function world({ questions = EXPECTED, replies = [], related, page = PAGE, model = 'claude-sonnet-5', clock, elementsLogged, modelDelayMs = 0, guardConfig = OPEN, flag = null, kvs = fakeKvs() } = {}) {
  const events = [];
  const logs = [];
  const askedRelated = [];
  const now = clock ?? (() => Date.UTC(2026, 10, 18, 9, 0));
  const spend = makeSpend(kvs, { now, sleep: () => new Promise((r) => setTimeout(r, 1)), log: (line) => logs.push(line) });
  const runs = new Map();
  const calls = { inFlight: 0, most: 0, cost: 0, sites: [] };
  let lastRun;
  let pending;
  let n = 0;
  const deps = {
    fetchPage: async (id, opts) => (events.push(`fetchPage ${id} ${opts?.withBody ? 'body' : ''}`.trim()), page.error ? page : { ...page, id }),
    findRelated: async (...args) => (events.push('findRelated'), askedRelated.push(args), related ?? { related: [], relatedIssues: [], sources: [] }),
    getQuestions: async () => (events.push('getQuestions'), { questions: typeof questions === 'function' ? questions() : questions, isDefault: false }),
    startRun: async ({ pageId, title, pageVersion, questions: qs, via, clipped, spend: reserve }) => {
      n += 1;
      const run = { runId: `run0000${n}`, pageId, title, pageVersion, status: 'reading', startedAt: `2026-11-18T09:0${n}:00Z`, questions: qs.map(({ id, text }) => ({ id, text })), ...(via ? { via } : {}), ...(clipped ? { clipped: true } : {}), ...(reserve ? { spend: reserve } : {}) };
      runs.set(run.runId, run);
      events.push('startRun');
      return run;
    },
    getRun: async (pageId, runId) => runs.get(runId),
    recordAnswers: async (run, { answers, missing }, pageQuestions) => {
      const byId = new Map(pageQuestions.map((q) => [q.id, q.expected]));
      const saved = { ...run, status: 'answered', questions: run.questions.map((q) => ({ ...q, expected: byId.get(q.id) || '' })), answers, missing };
      runs.set(run.runId, saved);
      events.push('recordAnswers');
      return saved;
    },
    recordWarm: async (run, warm) => {
      const saved = { ...run, warm };
      runs.set(run.runId, saved);
      events.push('recordWarm');
      return saved;
    },
    recordFindings: async (run, findings) => {
      const saved = { ...run, status: 'checked', findings };
      runs.set(run.runId, saved);
      if (replacesLastRun(lastRun, saved)) lastRun = saved;
      events.push('recordFindings');
      return saved;
    },
    recordFailure: async (run, error) => {
      runs.set(run.runId, { ...run, status: 'failed', error });
      events.push(`recordFailure ${error}`);
    },
    markPending: async (run) => (events.push('markPending'), (pending = run.runId)),
    // As store.js: a write with FAIL_IF_EXISTS, true only for the first call of a step.
    claimStep: async (pageId, runId, step) => {
      try {
        await kvs.set(`step:${pageId}:${runId}:${step}`, { at: new Date(now()).toISOString() }, { keyPolicy: 'FAIL_IF_EXISTS' });
        events.push(`claimStep ${step}`);
        return true;
      } catch {
        events.push(`claimStep ${step} taken`);
        return false;
      }
    },
    reserveSpend: async (need, source) => (events.push(`reserveSpend ${source}`), spend.reserve(need, source)),
    settleSpend: async (day, reserved, spent) => (events.push('settleSpend'), spend.settle(day, reserved, spent)),
    pickModel: async () => (events.push('pickModel'), model ? { model, price: PRICES[model] } : null),
    guardConfig,
    checkFlag: async (site) => (events.push(`checkFlag ${site.cloudId}`), flag),
    callModel: async (prompt, m, call) => {
      events.push(`callModel ${prompt.step} ${m}`);
      prompts.push(prompt);
      calls.sites.push(call?.site);
      const scripted = replies.shift() ?? { error: 'no scripted reply' };
      const reply = { ...scripted, cost: scripted.usage ? callCost(scripted.usage, call.price) : 0 };
      calls.cost += reply.cost;
      if (modelDelayMs) {
        calls.inFlight += 1;
        calls.most = Math.max(calls.most, calls.inFlight);
        await new Promise((r) => setTimeout(r, modelDelayMs));
        calls.inFlight -= 1;
      }
      return reply;
    },
    log: (line) => logs.push(line),
    ...(elementsLogged ? { elementsLogged } : {}),
    now,
  };
  const prompts = [];
  const engine = makeAutoRun(deps);
  // The panel's two resolver calls always come with the site of the platform's context.
  const run = { cold: (pageId) => engine.cold(pageId, SITE), compare: (pageId, runId) => engine.compare(pageId, runId, SITE) };
  const spentToday = () => kvs.data.get('spend:2026-11-18')?.spent ?? 0;
  return { engine: run, events, runs, prompts, logs, calls, kvs, spend, spentToday, askedRelated, lastRun: () => lastRun, pending: () => pending };
}

const promptText = (p) => p.messages.map((m) => m.content).join('\n');

test('cold step: rights, switches, model, questions, spend reserve, run, one cold call, answers; then the compare call', async () => {
  const w = world({ replies: [ANSWERS, FINDINGS] });
  const cold = await w.engine.cold('3964929');
  assert.equal(cold.status, 'answered');
  assert.equal(cold.compareWith, 'expected answers');
  assert.equal(cold.model, 'claude-sonnet-5');
  assert.deepEqual(cold.answers.map((a) => [a.q, a.notStated]), [[1, false], [2, true]]);
  assert.deepEqual(w.events, [
    'fetchPage 3964929 body',
    'checkFlag c0ffee00-site',
    'pickModel',
    'getQuestions',
    'reserveSpend button',
    'startRun',
    'callModel cold claude-sonnet-5',
    'recordAnswers',
    'settleSpend',
    'markPending',
  ]);
  const run = w.runs.get(cold.runId);
  assert.equal(run.via, 'button');
  assert.equal(run.model, 'claude-sonnet-5', 'the model is in the run record with the answers');
  assert.equal(w.pending(), cold.runId, 'a closed panel can continue this run');
  assert.equal(run.clipped, undefined);
  assert.equal(expectedOf(run).length, 2, 'expected answers are copied into the run after the answers');
  // The cold call saw neither expected answer.
  for (const q of EXPECTED) assert.ok(!promptText(w.prompts[0]).includes(q.expected));
  assert.match(promptText(w.prompts[0]), /Priya sends the quote/);

  const before = w.events.length;
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(done.status, 'checked');
  assert.deepEqual(done.findings, { A: 1, B: 0, C: 1, match: 0 });
  // The step is taken after its reads and before the model call, the spend and the record.
  assert.deepEqual(w.events.slice(before), ['fetchPage 3964929 body', 'checkFlag c0ffee00-site', 'pickModel', 'claimStep findings', 'callModel compare claude-sonnet-5', 'settleSpend', 'recordFindings']);
  assert.equal(w.prompts[1].step, 'compare');
  assert.match(promptText(w.prompts[1]), /Expected answer: The quote went to Acme on Nov 7\./);
  assert.equal(w.lastRun().runId, cold.runId);
  assert.equal(w.lastRun().model, 'claude-sonnet-5', 'and with the findings');
  assert.equal(done.run.model, 'claude-sonnet-5');
  assert.ok(!w.events.includes('findRelated'), 'no warm read with expected answers');
});

test('the spend limit refuses before the model is called, in words without sums, and the log says why', async () => {
  const kvs = fakeKvs();
  // The site was installed a day ago and has spent $0.99 today: the reserve of a run does not fit in $1.00.
  kvs.data.set('spend:install', { at: '2026-11-17T09:00:00.000Z', from: 'install event' });
  kvs.data.set('spend:2026-11-18', { spent: 990000, events: 0 });
  const w = world({ kvs, replies: [ANSWERS] });
  const res = await w.engine.cold('3964929');
  assert.equal(res.refused, 'budget');
  assert.equal(res.error, 'This site has used its one-click budget for now. It refills over time: about 18 runs available in 15 hours.');
  assert.doesNotMatch(res.error, /\$|abuse|blocked|1\.00/);
  assert.ok(!w.events.some((e) => /startRun|callModel/.test(e)));
  assert.equal(w.spentToday(), 990000, 'nothing reserved');
  assert.ok(w.logs.includes('guard deny reason=budget site=c0ffee00-site'));
});

test('no available model: no run, nothing reserved', async () => {
  const w = world({ model: null });
  const res = await w.engine.cold('3964929');
  assert.match(res.error, /None of the models/);
  assert.ok(!w.events.some((e) => /reserveSpend|startRun|callModel/.test(e)));
});

test('a page the person cannot see stops before anything else', async () => {
  const w = world({ page: { error: 'Confluence returned 404 for page 3964929', status: 404 } });
  assert.match((await w.engine.cold('3964929')).error, /404/);
  assert.deepEqual(w.events, ['fetchPage 3964929 body']);
});

test('a failed model call is retried once, then the run is failed and the last run stays', async () => {
  const w = world({ replies: [{ error: 'The model is busy. Try again in a minute.' }, { data: { answers: [] } }] });
  const res = await w.engine.cold('3964929');
  assert.equal(res.status, 'failed');
  assert.match(res.error, /^The cold read failed: No valid answers found/);
  assert.equal(w.events.filter((e) => e.startsWith('callModel')).length, 2);
  assert.equal(w.runs.get(res.runId).status, 'failed');
  assert.equal(w.spentToday(), w.calls.cost, 'the failed run counts what its calls cost, and its second step is not reserved');
  assert.equal(w.lastRun(), undefined);
  // A failed run cannot be compared.
  assert.match((await w.engine.compare('3964929', res.runId)).error, /failed\. Start a new cold read/);
});

test('a paid unreadable reply is not called again: one call and the step fails; a call that got no reply is made once more', async () => {
  const paid = world({ replies: [withUsage({ data: { answers: [] }, ms: 5 }, 1000, 10), ANSWERS] });
  const res = await paid.engine.cold('3964929');
  assert.equal(res.status, 'failed');
  assert.match(res.error, /No valid answers found/);
  assert.equal(paid.events.filter((e) => e.startsWith('callModel')).length, 1);
  assert.equal(paid.spentToday(), 2100, 'only the one call is counted');
  const noReply = world({ replies: [{ error: 'The model service did not answer. Try again later.', ms: 5 }, ANSWERS] });
  assert.equal((await noReply.engine.cold('3964929')).status, 'answered');
  assert.equal(noReply.events.filter((e) => e.startsWith('callModel')).length, 2);
});

test('no retry when the first call took too long for the 25 s of a resolver', async () => {
  let t = Date.UTC(2026, 10, 18, 9, 0);
  const w = world({ replies: [{ error: 'The model service did not answer. Try again later.' }, ANSWERS], clock: () => (t += 7000) });
  const res = await w.engine.cold('3964929');
  assert.equal(res.status, 'failed');
  assert.equal(w.events.filter((e) => e.startsWith('callModel')).length, 1);
});

test('a page longer than 40 000 characters: the model gets the first 40 000 and the run says so', async () => {
  const w = world({ page: { ...PAGE, text: `${'x'.repeat(PAGE_CHARS)}TAIL` }, replies: [ANSWERS] });
  const res = await w.engine.cold('3964929');
  assert.equal(PAGE_CHARS, 40000);
  assert.equal(res.clipped, true);
  assert.equal(w.runs.get(res.runId).clipped, true);
  assert.match(promptText(w.prompts[0]), new RegExp(`x{${PAGE_CHARS}}\n</page_text>`));
  assert.doesNotMatch(promptText(w.prompts[0]), /TAIL/);
});

// A page that links to a page and a Jira issue, and what the warm read's step 2 and step 3 reply.
const LINKS = { pageIds: ['42'], pageTitles: [], issueKeys: ['REN-1'] };
const LINKED_PAGE = { ...PAGE, spaceId: '3932163', links: LINKS };
const RELATED = {
  related: [{ pageId: '42', title: 'Acme renewal notes', text: 'Quote sent on Nov 7.' }],
  relatedIssues: [{ issueKey: 'REN-1', title: 'Send quote', status: 'Done', text: 'Sent to Dana Ruiz on Nov 7.' }],
  sources: [{ pageId: '42', title: 'Acme renewal notes' }, { issueKey: 'REN-1', title: 'Send quote' }],
};
const WARM_ANSWERS = toolReply({ answers: [
  { q: 1, answer: 'The page says the quote is drafted; REN-1 says it was sent to Dana Ruiz on Nov 7 (REN-1).', sources: [{ source: 'REN-1', quote: 'Sent to Dana Ruiz on Nov 7.' }] },
  { q: 2, answer: 'NOT STATED', sources: [] },
] });
// The three conflict checks of step 3: two of three see a conflict on question 1 (the first of them gives the quotes);
// question 2 is NOT STATED on the page and is never a conflict, whatever a check says.
const conflict = (q, extra = {}) => ({ q, outcome: 'conflict', page_quote: 'Priya sends the quote to Acme procurement by Nov 14.', source: 'REN-1', source_quote: 'Sent to Dana Ruiz on Nov 7.', sentence: 'The page says Priya sends the quote by Nov 14. REN-1 says it was sent on Nov 7.', ...extra });
const none = (q) => ({ q, outcome: 'match', page_quote: '', source: '', source_quote: '', sentence: '' });
const CHECKS = [
  toolReply({ outcomes: [conflict(1), conflict(2)] }),
  toolReply({ outcomes: [none(1), none(2)] }),
  toolReply({ outcomes: [conflict(1, { sentence: 'Second.' }), conflict(2)] }),
];
// A site installed long ago: the day limit, not the $0.60 of a fresh installation (a warm read reserves five calls).
const oldSite = () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-11-01T00:00:00.000Z', from: 'install event' });
  return kvs;
};

test('without expected answers: the warm read in two more steps - the answers with the linked sources, then three conflict checks', async () => {
  const w = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [ANSWERS, WARM_ANSWERS, ...CHECKS] });
  const cold = await w.engine.cold('3964929');
  assert.equal(cold.status, 'answered');
  assert.equal(cold.compareWith, 'warm read');

  // Step 2: the page and the linked sources, the questions, and neither the cold answers nor a verdict.
  const step2 = await w.engine.compare('3964929', cold.runId);
  assert.deepEqual(step2, { status: 'warmed', pageId: '3964929', runId: cold.runId, model: 'claude-sonnet-5', compareWith: 'warm read' });
  assert.equal(w.prompts[1].step, 'warm');
  assert.equal(w.prompts[1].tool.function.name, 'submit_answers');
  const text = promptText(w.prompts[1]);
  assert.ok(text.includes(WARM_ANSWERS_RULES), 'the rules of the answers with sources');
  assert.match(text, /<linked_page id="42" title="Acme renewal notes">\nQuote sent on Nov 7\.\n<\/linked_page>/);
  assert.match(text, /<jira_issue key="REN-1" title="Send quote" status="Done">\nSent to Dana Ruiz on Nov 7\.\n<\/jira_issue>/);
  assert.ok(!text.includes('The quote is drafted.'), 'the cold answers are not given');
  const warmed = w.runs.get(cold.runId);
  assert.equal(warmed.status, 'answered', 'not finished yet');
  assert.deepEqual(warmed.warm.sources, [{ pageId: '42', title: 'Acme renewal notes', used: false }, { issueKey: 'REN-1', title: 'Send quote', used: true }]);
  assert.deepEqual(warmed.warm.answers[0].sources, [{ issueKey: 'REN-1', title: 'Send quote', quote: 'Sent to Dana Ruiz on Nov 7.' }]);
  assert.equal(warmed.warm.links, 2);
  assert.deepEqual(interruptedRun(warmed, undefined), { runId: cold.runId, compareWith: 'warm read', warmed: true, answeredAt: undefined }, 'Continue takes step 3');
  assert.deepEqual(w.askedRelated[0], [{ pageId: '3964929', spaceId: '3932163', links: LINKS }, { sources: WARM_SOURCES, chars: WARM_SOURCE_CHARS }]);
  assert.ok(w.logs.includes(`autorun warm page=3964929 run=${cold.runId} links=2 sources=42,REN-1`));

  // Step 3: three calls with one and the same request: the page, the sources (read again) and both answers.
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(done.status, 'checked');
  assert.equal(done.compareWith, 'warm read');
  assert.deepEqual(done.findings, { A: 1, B: 0, C: 0, match: 1 });
  assert.deepEqual(w.prompts.slice(2).map((p) => p.step), ['conflict', 'conflict', 'conflict']);
  assert.ok(w.prompts[2] === w.prompts[3] && w.prompts[3] === w.prompts[4], 'the same request three times');
  const check = promptText(w.prompts[2]);
  assert.ok(check.includes(CONFLICT_RULES));
  assert.ok(check.includes('Question 1: Where does the work stand right now?\nAnswer from the page alone: The quote is drafted.\nAnswer with the linked issues and pages: The page says the quote is drafted; REN-1 says it was sent to Dana Ruiz on Nov 7 (REN-1).'));
  assert.match(check, /<page_text>\nPriya sends the quote to Acme procurement by Nov 14\.\n<\/page_text>/);
  assert.match(check, /<jira_issue key="REN-1"/);
  assert.equal(w.askedRelated.length, 2, 'the sources are read again for step 3');
  // Question 1: two votes of three, the quotes and sentence of the first of them; question 2: NOT STATED - a match.
  assert.deepEqual(done.run.findings.map(({ questionId, ...f }) => f), [
    {
      q: 1,
      verdict: 'A',
      note: 'The page says Priya sends the quote by Nov 14. REN-1 says it was sent on Nov 7.',
      questions: [1],
      quotes: { page: 'Priya sends the quote to Acme procurement by Nov 14.', source: { issueKey: 'REN-1', title: 'Send quote', quote: 'Sent to Dana Ruiz on Nov 7.' } },
      parts: [{ q: 1, note: 'The page says Priya sends the quote by Nov 14. REN-1 says it was sent on Nov 7.', quotes: { page: 'Priya sends the quote to Acme procurement by Nov 14.', source: { issueKey: 'REN-1', title: 'Send quote', quote: 'Sent to Dana Ruiz on Nov 7.' } } }],
    },
    { q: 2, verdict: 'match', note: '' },
  ]);
  assert.ok(w.logs.includes(`autorun conflict page=3964929 run=${cold.runId} model=claude-sonnet-5 votes=1:2,2:2 replies=3`));
  assert.deepEqual(Object.keys(done.run.usage), ['cold', 'warm', 'conflict']);
  assert.equal(done.run.warm.answers.length, 2, 'the answers of step 2 stay in the record for the panel');
  assert.equal(w.lastRun().runId, cold.runId);
  assert.deepEqual(w.events.filter((e) => e.startsWith('callModel')), ['callModel cold claude-sonnet-5', 'callModel warm claude-sonnet-5', 'callModel conflict claude-sonnet-5', 'callModel conflict claude-sonnet-5', 'callModel conflict claude-sonnet-5']);
  // A further call is refused: the findings are saved.
  assert.match((await w.engine.compare('3964929', cold.runId)).error, /already saved/);
});

test('step 3: the quotes come from the first vote whose two quotes are found; else from the two answers; else no finding', async () => {
  const wrong = toolReply({ outcomes: [conflict(1, { page_quote: 'Priya sent the quote.', sentence: 'Wrong.' }), none(2)] });
  const run3 = async (answers, checks) => {
    const w = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [answers, WARM_ANSWERS, ...checks] });
    const cold = await w.engine.cold('3964929');
    await w.engine.compare('3964929', cold.runId);
    return { w, cold, done: await w.engine.compare('3964929', cold.runId) };
  };
  // The first two votes quote a line that is not on the page; the third one's quotes are found: they are taken.
  const third = await run3(ANSWERS, [wrong, wrong, CHECKS[0]]);
  assert.deepEqual(third.done.run.findings[0].quotes, { page: 'Priya sends the quote to Acme procurement by Nov 14.', source: { issueKey: 'REN-1', title: 'Send quote', quote: 'Sent to Dana Ruiz on Nov 7.' } });
  assert.equal(third.done.run.findings[0].note, 'The page says Priya sends the quote by Nov 14. REN-1 says it was sent on Nov 7.');
  // No vote has found quotes: the quote of the cold answer (on the page) and of the answer of step 2 (in REN-1).
  const quoted = toolReply({ answers: [{ q: 1, answer: 'Priya sends the quote by Nov 14.', quote: 'Priya sends the quote to Acme procurement by Nov 14.' }, { q: 2, answer: 'NOT STATED', quote: '' }] });
  const fallback = await run3(quoted, [wrong, wrong, wrong]);
  assert.deepEqual(fallback.done.findings, { A: 1, B: 0, C: 0, match: 1 });
  assert.deepEqual(fallback.done.run.findings[0].quotes, { page: 'Priya sends the quote to Acme procurement by Nov 14.', source: { issueKey: 'REN-1', title: 'Send quote', quote: 'Sent to Dana Ruiz on Nov 7.' } });
  assert.equal(fallback.done.run.findings[0].note, 'Wrong.', 'the sentence of the first vote');
  // Neither: the cold answer's quote ("drafted") is not on the page - no finding, and the log says so without text.
  const none3 = await run3(ANSWERS, [wrong, wrong, wrong]);
  assert.deepEqual(none3.done.findings, { A: 0, B: 0, C: 0, match: 2 });
  assert.ok(none3.w.logs.includes(`autorun conflict page=3964929 run=${none3.cold.runId} q=1 dropped: page quote not found, source quote found; no other pair of quotes found`));
  assert.ok(!none3.w.logs.some((l) => l.includes('Priya sent the quote')), 'no quote in the log');
});

test('step 3: one failed check is no vote; two failed checks fail the step', async () => {
  const busy = { error: 'The model is busy. Try again in a minute.', ms: 5 };
  // Checks run side by side: each takes its reply and, on a failure, its retry, in the order they ask.
  const one = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [ANSWERS, WARM_ANSWERS, CHECKS[0], CHECKS[2], busy, busy] });
  const c1 = await one.engine.cold('3964929');
  await one.engine.compare('3964929', c1.runId);
  const done = await one.engine.compare('3964929', c1.runId);
  assert.equal(done.status, 'checked');
  assert.equal(done.findings.A, 1, 'two votes of the three calls');
  const two = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [ANSWERS, WARM_ANSWERS, CHECKS[0], busy, busy, busy, busy] });
  const c2 = await two.engine.cold('3964929');
  await two.engine.compare('3964929', c2.runId);
  const failed = await two.engine.compare('3964929', c2.runId);
  assert.equal(failed.status, 'failed');
  assert.equal(two.spentToday(), two.calls.cost, 'only what the calls cost stays counted');
});

test('the reserve of a warm read: step 2 settles its part and leaves the rest to step 3, which settles it', async () => {
  const w = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [withUsage(ANSWERS, 1158, 440), withUsage(WARM_ANSWERS, 2500, 400), ...CHECKS.map((c) => withUsage(c, 2600, 500))] });
  const cold = await w.engine.cold('3964929');
  const { spend } = w.runs.get(cold.runId);
  assert.ok(spend.warm > 0 && spend.reserved > spend.warm, 'the reserve of steps 2 and 3, and the part of step 2');
  assert.equal(w.spentToday(), 6716 + spend.reserved);
  await w.engine.compare('3964929', cold.runId);
  const after2 = w.runs.get(cold.runId).spend;
  assert.deepEqual(after2, { day: '2026-11-18', reserved: spend.reserved - spend.warm });
  assert.equal(w.spentToday(), 6716 + callCost({ input_tokens: 2500, output_tokens: 400 }, PRICES['claude-sonnet-5']) + after2.reserved);
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(done.run.spend.reserved, 0);
  assert.equal(w.spentToday(), w.calls.cost, 'only what the five calls cost stays counted');
});

test('without expected answers and without links: the run ends after the cold step, without findings', async () => {
  const w = world({ questions: NO_EXPECTED, replies: [withUsage(ANSWERS, 1158, 440)] });
  const cold = await w.engine.cold('3964929');
  assert.equal(cold.status, 'checked');
  assert.equal(cold.compareWith, null);
  assert.deepEqual(cold.run.findings, []);
  assert.deepEqual(cold.run.warm.sources, []);
  assert.equal(cold.run.warm.links, 0);
  assert.equal(w.lastRun().runId, cold.runId, 'a finished run');
  assert.equal(w.pending(), undefined, 'nothing to continue');
  assert.equal(w.events.filter((e) => e.startsWith('callModel')).length, 1, 'only the cold call');
  assert.ok(!w.events.includes('findRelated'));
  assert.equal(w.spentToday(), 6716, 'only the cold call is counted: no reserve is left');
  assert.equal(cold.run.spend.reserved, 0);
  assert.match((await w.engine.compare('3964929', cold.runId)).error, /already saved/);
});

test('links that cannot be read: step 2 ends the run without findings and without a model call', async () => {
  const w = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, replies: [withUsage(ANSWERS, 1158, 440)] });
  const cold = await w.engine.cold('3964929');
  assert.equal(cold.status, 'answered');
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(done.status, 'checked');
  assert.equal(done.compareWith, null);
  assert.deepEqual(done.run.findings, []);
  assert.deepEqual(done.run.warm, { at: done.run.warm.at, links: 2, sources: [] });
  assert.equal(w.events.filter((e) => e.startsWith('callModel')).length, 1);
  assert.equal(w.spentToday(), 6716, 'the reserve of steps 2 and 3 is freed');
});

test('a failed step 2 fails the run and frees the reserve of step 3 too', async () => {
  const busy = { error: 'The model is busy. Try again in a minute.', ms: 5 };
  const w = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [withUsage(ANSWERS, 1158, 440), busy, busy] });
  const cold = await w.engine.cold('3964929');
  const res = await w.engine.compare('3964929', cold.runId);
  assert.equal(res.status, 'failed');
  assert.match(res.error, /busy/);
  assert.equal(w.spentToday(), w.calls.cost);
  assert.equal(w.runs.get(cold.runId).spend.reserved, 0);
  assert.equal(w.lastRun(), undefined);
});

test('compare takes only answered one-click runs, once', async () => {
  const w = world({ replies: [ANSWERS, FINDINGS] });
  assert.match((await w.engine.compare('3964929', 'nosuchrun1')).error, /no one-click cold read/);
  // A run the agent started (no via) is not finished by the button.
  w.runs.set('agentrun1', { runId: 'agentrun1', status: 'answered', questions: EXPECTED, answers: [] });
  assert.match((await w.engine.compare('3964929', 'agentrun1')).error, /no one-click cold read/);
  const cold = await w.engine.cold('3964929');
  await w.engine.compare('3964929', cold.runId);
  assert.match((await w.engine.compare('3964929', cold.runId)).error, /already saved/);
});

test('compare refuses a one-click run whose answers were never saved, in the panel\'s words', async () => {
  const w = world();
  w.runs.set('cutrun0001', { runId: 'cutrun0001', status: 'reading', via: 'button', questions: EXPECTED });
  const res = await w.engine.compare('3964929', 'cutrun0001');
  assert.match(res.error, /did not save its answers.*Start a new cold read/);
  assert.ok(!w.events.some((e) => e.startsWith('callModel')));
});

const withUsage = (reply, input, output) => ({ ...reply, usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } });

test('the tokens of each step are in the run record: cold, then compare; a call that got no reply adds none', async () => {
  const noReply = { error: 'The model service did not answer. Try again later.', ms: 5 };
  const w = world({ replies: [withUsage(ANSWERS, 1158, 440), noReply, withUsage(FINDINGS, 1533, 700)] });
  const cold = await w.engine.cold('3964929');
  assert.deepEqual(w.runs.get(cold.runId).usage, { cold: { in: 1158, out: 440, usd: 0.006716 } });
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(w.events.filter((e) => e === 'callModel compare claude-sonnet-5').length, 2);
  assert.deepEqual(done.run.usage, { cold: { in: 1158, out: 440, usd: 0.006716 }, compare: { in: 1533, out: 700, usd: 0.010066 } });
  assert.deepEqual(w.lastRun().usage, done.run.usage);
  assert.equal(done.run.model, 'claude-sonnet-5');
  // The compare call is asked for the elements first; the record keeps only verdict and note.
  assert.deepEqual(Object.keys(w.prompts[1].tool.function.parameters.properties.findings.items.properties), ['q', 'expected_elements', 'saved_elements', 'verdict', 'note']);
  assert.match(promptText(w.prompts[1]), /When in doubt, give a finding, not "match"/);
  for (const f of done.run.findings) assert.deepEqual(Object.keys(f).sort(), ['note', 'q', 'verdict']);
});

test('a failed step keeps the tokens it spent and the model in the failed run', async () => {
  const w = world({ replies: [withUsage({ data: { answers: [] }, ms: 5 }, 1000, 10), { error: 'The model is busy. Try again in a minute.', ms: 5 }] });
  const res = await w.engine.cold('3964929');
  assert.equal(res.status, 'failed');
  const run = w.runs.get(res.runId);
  assert.deepEqual(run.usage, { cold: { in: 1000, out: 10, usd: 0.0021 } });
  assert.equal(run.model, 'claude-sonnet-5');
});

test('Continue: the compare step of a run answered earlier adds its tokens to those of the cold step', async () => {
  const w = world({ replies: [withUsage(ANSWERS, 1158, 440)] });
  const cold = await w.engine.cold('3964929');
  // The panel was closed after step 1; the second step runs later in a new resolver call.
  const later = world({ replies: [withUsage(FINDINGS, 1548, 353)] });
  later.runs.set(cold.runId, w.runs.get(cold.runId));
  const done = await later.engine.compare('3964929', cold.runId);
  assert.deepEqual(done.run.usage, { cold: { in: 1158, out: 440, usd: 0.006716 }, compare: { in: 1548, out: 353, usd: 0.006626 } });
});

test('the elements go to the log only when the environment allows it (development), never into the run record', async () => {
  const withElements = toolReply({ findings: [{ q: 1, expected_elements: 'who: we; does: sent', saved_elements: 'who: -; does: drafted', verdict: 'A', note: 'Say it was sent.' }, { q: 2, expected_elements: 'who: Priya', saved_elements: '', verdict: 'C', note: 'Name it.' }] });
  for (const [allowed, expectLine] of [[undefined, false], [() => false, false], [() => true, true]]) {
    const w = world({ replies: [ANSWERS, withElements], elementsLogged: allowed });
    const cold = await w.engine.cold('3964929');
    const done = await w.engine.compare('3964929', cold.runId);
    const line = w.logs.find((l) => l.startsWith('autorun elements'));
    assert.equal(Boolean(line), expectLine, String(allowed));
    if (line) assert.match(line, /who: we; does: sent/);
    assert.ok(!JSON.stringify(done.run).includes('who: we'), 'not in the run record');
  }
});

// Pages with more than five compared questions: the compare step goes in parts of up to five, called side by side.
const manyQuestions = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, text: `Question number ${i + 1}?`, expected: `Expected answer ${i + 1}.` }));
const manyAnswers = (n) => toolReply({ answers: Array.from({ length: n }, (_, i) => ({ q: i + 1, answer: `Saved answer ${i + 1}.`, quote: `q${i + 1}` })) });
const findingsFor = (qs, input, output) => withUsage(toolReply({ findings: qs.map((q) => ({ q, expected_elements: `who: e${q}`, saved_elements: `who: s${q}`, verdict: q % 2 ? 'match' : 'A', note: q % 2 ? '' : `Fix ${q}.` })) }), input, output);
const comparePrompts = (w) => w.prompts.filter((p) => p.step === 'compare');
// The compared questions of a part come before the other saved answers of the run; othersIn: the questions after them.
const OTHERS = 'Other saved answers of this run (context only: give no verdict for them):';
const numbersIn = (text) => [...String(text ?? '').matchAll(/^Question (\d+): /gm)].map((m) => Number(m[1]));
const questionsIn = (p) => numbersIn(promptText(p).split(OTHERS)[0]);
const othersIn = (p) => numbersIn(promptText(p).split(OTHERS)[1]);

test('ten compared questions: two parts of five called side by side, findings joined by question, tokens summed', async () => {
  const w = world({
    questions: manyQuestions(10),
    replies: [
      manyAnswers(10),
      findingsFor([5, 3, 1, 2, 4], 1900, 900),
      // The second part also names question 2, which is not its own: that verdict is dropped.
      findingsFor([10, 8, 6, 9, 7, 2], 1950, 1000),
    ],
    elementsLogged: () => true,
    modelDelayMs: 20,
  });
  const cold = await w.engine.cold('3964929');
  assert.equal(cold.compareWith, 'expected answers');
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(done.status, 'checked');
  const parts = comparePrompts(w);
  assert.equal(parts.length, 2);
  assert.equal(w.calls.most, 2, 'both parts wait for the model at the same time');
  assert.deepEqual(parts.map(questionsIn), [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
  // Each part gets the saved answers of the other part, but not their expected answers.
  assert.deepEqual(parts.map(othersIn), [[6, 7, 8, 9, 10], [1, 2, 3, 4, 5]]);
  for (const [p, others] of [[parts[0], [6, 7, 8, 9, 10]], [parts[1], [1, 2, 3, 4, 5]]]) {
    for (const q of others) {
      assert.ok(promptText(p).includes(`Question ${q}: Question number ${q}?\nSaved answer: Saved answer ${q}.`), `${q}`);
      assert.ok(!promptText(p).includes(`Expected answer ${q}.`), `no expected answer of ${q}`);
    }
  }
  assert.deepEqual(parts.map((p) => p.maxOutputTokens), [1800, 1800], 'the output limit is counted per part');
  assert.deepEqual(done.run.findings.map((f) => f.q), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(done.run.findings.find((f) => f.q === 2).note, 'Fix 2.', 'question 2 keeps the verdict of its own part');
  assert.deepEqual(done.findings, { A: 5, B: 0, C: 0, match: 5 });
  assert.deepEqual(done.run.usage.compare, { in: 3850, out: 1900, usd: 0.0267 });
  assert.deepEqual(w.lastRun().usage, done.run.usage);
  assert.equal(w.logs.filter((l) => l.startsWith('autorun elements')).length, 2, 'one elements line per part');
  for (const f of done.run.findings) assert.deepEqual(Object.keys(f).sort(), ['note', 'q', 'verdict']);
});

test('six compared questions: two parts of three', async () => {
  const w = world({ questions: manyQuestions(6), replies: [manyAnswers(6), findingsFor([1, 2, 3], 1500, 600), findingsFor([4, 5, 6], 1510, 610)], modelDelayMs: 20 });
  const cold = await w.engine.cold('3964929');
  const done = await w.engine.compare('3964929', cold.runId);
  assert.deepEqual(comparePrompts(w).map(questionsIn), [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(comparePrompts(w).map(othersIn), [[4, 5, 6], [1, 2, 3]]);
  assert.deepEqual(comparePrompts(w).map((p) => p.maxOutputTokens), [1200, 1200]);
  assert.equal(w.calls.most, 2);
  assert.deepEqual(done.run.findings.map((f) => f.q), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(done.run.usage.compare, { in: 3010, out: 1210, usd: 0.01812 });
});

test('five compared questions: one compare call with all five, as before', async () => {
  const w = world({ questions: manyQuestions(5), replies: [manyAnswers(5), findingsFor([1, 2, 3, 4, 5], 1940, 950)] });
  const cold = await w.engine.cold('3964929');
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(comparePrompts(w).length, 1);
  assert.deepEqual(questionsIn(comparePrompts(w)[0]), [1, 2, 3, 4, 5]);
  assert.ok(!promptText(comparePrompts(w)[0]).includes(OTHERS), 'no other answers: every question is compared');
  assert.equal(comparePrompts(w)[0].maxOutputTokens, 1800);
  assert.deepEqual(done.run.findings.map((f) => f.q), [1, 2, 3, 4, 5]);
  assert.deepEqual(done.run.usage.compare, { in: 1940, out: 950, usd: 0.01338 });
});

test('one failed part fails the step with its message and keeps the tokens of all parts; Try again starts a new run', async () => {
  // Part 1 answers; part 2 gives an unreadable reply. It was paid for, so it is not called again.
  const unreadable = withUsage({ data: { findings: [] }, ms: 5 }, 1950, 20);
  const w = world({ questions: manyQuestions(10), replies: [manyAnswers(10), findingsFor([1, 2, 3, 4, 5], 1900, 900), unreadable] });
  const cold = await w.engine.cold('3964929');
  const res = await w.engine.compare('3964929', cold.runId);
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'The cold read failed: No valid findings found. Give a verdict for each question that has an expected answer.');
  assert.equal(comparePrompts(w).length, 2, 'one call of each part: the paid unreadable reply is not called again');
  const run = w.runs.get(cold.runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.findings, undefined, 'no findings for half of the questions');
  assert.deepEqual(run.usage.compare, { in: 3850, out: 920, usd: 0.0169 });
  assert.equal(w.lastRun(), undefined, 'the last finished run stays');
  // The panel's "Try again" runs both steps anew.
  const again = await w.engine.cold('3964929');
  assert.equal(again.status, 'failed', 'a new cold step is taken (no scripted reply is left)');
  assert.notEqual(again.runId, cold.runId);
});

// Run mwoceb2z3us2 (page 3964929, 20.11.2026, development 6.5.0): the elements line did (findings ?? []).map on a
// reply whose findings were not an array, and the error broke the step past its retry. A string of JSON is read now
// (next test); findings that are still not a list - an object - are logged and fail the step, not a crash (the reply
// was paid for, so it is not called again).
test('in development a reply whose findings are an object, not a list, is logged and fails the step, not a crash', async () => {
  const objectFindings = withUsage(toolReply({ findings: { q: 1, verdict: 'A', note: 'x' } }), 2000, 900);
  const w = world({ replies: [ANSWERS, objectFindings, withUsage(FINDINGS, 2000, 950)], elementsLogged: () => true });
  const cold = await w.engine.cold('3964929');
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(done.status, 'failed', 'no second call after a paid reply');
  assert.equal(comparePrompts(w).length, 1);
  assert.deepEqual(w.runs.get(cold.runId).usage.compare, { in: 2000, out: 900, usd: 0.013 });
  const lines = w.logs.filter((l) => l.startsWith('autorun elements'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"findingsType":"object"/);
  assert.ok(w.logs.some((l) => /autorun step=compare attempt=1 failed: findings must be a JSON array/.test(l)));
});

// The first reply of the compare step of run mwockn0pdpm5 (page 5177345, 20.11.2026), as the development log has it:
// the findings field is a string holding the JSON of the whole object {"findings":[...]}.
const RECORDED_STRING_FINDINGS = "{\"findings\":[{\"q\":1,\"expected_elements\":\"who: quote (sender implied); does: sent, confirmed receipt, approved; on what or for whom: Dana Ruiz, contract terms; details: Nov 10 (REN-3), Nov 6 legal approval\",\"saved_elements\":\"who: quote/legal; does: sent, confirmed, approved, waiting; on what or for whom: Dana Ruiz, contract terms; details: Nov 10 (REN-3), Nov 6, plus 'waiting for Dana's reply'\",\"verdict\":\"match\",\"note\":\"\"},{\"q\":2,\"expected_elements\":\"who: Tom (via task in REN); does: follow up by email; on what or for whom: Dana Ruiz; details: Nov 17, if she has not replied\",\"saved_elements\":\"who: Tom; does: create task, follow up by email; on what or for whom: Dana; details: Nov 17, if not replied\",\"verdict\":\"match\",\"note\":\"\"},{\"q\":3,\"expected_elements\":\"who: (unspecified); does: decided; on what or for whom: term and price; details: two-year term at current price\",\"saved_elements\":\"who: (unspecified); does: decided; on what or for whom: term and price; details: two-year term at current price\",\"verdict\":\"match\",\"note\":\"\"},{\"q\":4,\"expected_elements\":\"who: (unspecified, already done); does: sent quote; on what or for whom: Dana Ruiz; details: Nov 10, REN-3, do not repeat\",\"saved_elements\":\"who: (unspecified); does: should not send again; on what or for whom: quote; details: missing date/ticket REN-3\",\"verdict\":\"match\",\"note\":\"missing the Nov 10 / REN-3 reference, which is an allowed detail of something already done.\"},{\"q\":5,\"expected_elements\":\"who: we (Oleg/Tom); does: waiting; on what or for whom: Dana Ruiz (Initech procurement); details: reply about quote\",\"saved_elements\":\"who: they (Tom/Oleg's team); does: waiting; on what or for whom: Dana Ruiz; details: reply to quote\",\"verdict\":\"match\",\"note\":\"\"}]}";

test('a reply whose findings come as a string of JSON gives the findings with the first call, without a retry', async () => {
  const w = world({ questions: manyQuestions(5), replies: [manyAnswers(5), withUsage(toolReply({ findings: RECORDED_STRING_FINDINGS }), 2041, 732)], elementsLogged: () => true });
  const cold = await w.engine.cold('5177345');
  const done = await w.engine.compare('5177345', cold.runId);
  assert.equal(done.status, 'checked');
  assert.equal(comparePrompts(w).length, 1, 'one model call');
  assert.deepEqual(done.run.usage.compare, { in: 2041, out: 732, usd: 0.011402 }, 'the tokens of one call');
  assert.ok(!w.logs.some((l) => /attempt=1 failed/.test(l)), 'no failed attempt');
  assert.deepEqual(done.findings, { A: 0, B: 0, C: 0, match: 5 });
  assert.match(done.run.findings[3].note, /REN-3/);
  for (const f of done.run.findings) assert.deepEqual(Object.keys(f).sort(), ['note', 'q', 'verdict']);
});

test('answers that come as a string of JSON are read with the first cold call', async () => {
  const answers = [{ q: 1, answer: 'The quote is drafted.', quote: 'drafted' }, { q: 2, answer: 'NOT STATED', quote: '' }];
  const w = world({ replies: [withUsage(toolReply({ answers: JSON.stringify({ answers }) }), 1158, 440)] });
  const cold = await w.engine.cold('3964929');
  assert.equal(cold.status, 'answered');
  assert.equal(w.prompts.length, 1);
  assert.deepEqual(w.runs.get(cold.runId).usage, { cold: { in: 1158, out: 440, usd: 0.006716 } });
  assert.deepEqual(cold.answers.map((a) => [a.q, a.notStated]), [[1, false], [2, true]]);
});

// ---- The spend limit and the switches of the one-click run. ----

test('each switch refuses the button before any model call or reserve, in the same words, and the log says which', async () => {
  const cases = [
    [{ guardConfig: { ...OPEN, BUTTON_EXPIRES: '2026-11-18T08:59:00Z' } }, 'expired', false],
    [{ guardConfig: { ...OPEN, BUTTON_ENABLED: false } }, 'disabled', false],
    [{ guardConfig: { ...OPEN, BLOCKED_CLOUD_IDS: ['c0ffee00-site'] } }, 'blocked', false],
    [{ flag: { on: false, reason: 'rule_match', rule: 'block-site' } }, 'blocked', true],
    [{ flag: { on: false, reason: 'disabled' } }, 'disabled', true],
  ];
  for (const [options, reason, flagRead] of cases) {
    const w = world({ ...options, replies: [ANSWERS] });
    const res = await w.engine.cold('3964929');
    assert.deepEqual(res, { error: UNAVAILABLE, refused: 'unavailable' }, reason);
    assert.ok(w.logs.includes(`guard deny reason=${reason} site=c0ffee00-site`), reason);
    assert.ok(!w.events.some((e) => /pickModel|reserveSpend|startRun|callModel/.test(e)), reason);
    assert.equal(w.events.includes('checkFlag c0ffee00-site'), flagRead, `${reason}: the flag is read only if the code lets the run go`);
    assert.equal(w.spentToday(), 0);
  }
  // Another site is not blocked by the list; a flag that could not be read leaves the button on.
  assert.equal((await world({ guardConfig: { ...OPEN, BLOCKED_CLOUD_IDS: ['other-site'] }, replies: [ANSWERS] }).engine.cold('3964929')).status, 'answered');
  assert.equal((await world({ flag: { on: true, reason: 'unavailable' }, replies: [ANSWERS] }).engine.cold('3964929')).status, 'answered');
  // A flag with no rule for this environment (a production box left unticked in the console) leaves the button on.
  assert.equal((await world({ flag: { on: false, reason: 'default' }, replies: [ANSWERS] }).engine.cold('3964929')).status, 'answered');
});

test('the second step: a switch turned off between the steps stops it; the spend limit does not', async () => {
  const open = world({ replies: [ANSWERS] });
  const cold = await open.engine.cold('3964929');
  const blocked = world({ guardConfig: { ...OPEN, BLOCKED_CLOUD_IDS: ['c0ffee00-site'] }, replies: [FINDINGS] });
  blocked.runs.set(cold.runId, open.runs.get(cold.runId));
  assert.deepEqual(await blocked.engine.compare('3964929', cold.runId), { error: UNAVAILABLE, refused: 'unavailable' });
  assert.ok(!blocked.events.some((e) => e.startsWith('callModel')));

  // The day is used up by other runs after the cold step: Continue still takes the second step.
  const kvs = fakeKvs();
  const w = world({ kvs, replies: [withUsage(ANSWERS, 1158, 440), withUsage(FINDINGS, 2041, 900)] });
  const first = await w.engine.cold('3964929');
  kvs.data.set('spend:2026-11-18', { spent: 1050000, events: 0 });
  const done = await w.engine.compare('3964929', first.runId);
  assert.equal(done.status, 'checked');
});

test('the reserve of both steps is counted before the cold call and replaced by what the calls cost after each step', async () => {
  const w = world({ replies: [withUsage(ANSWERS, 1158, 440), withUsage(FINDINGS, 2041, 900)] });
  const cold = await w.engine.cold('3964929');
  const run = w.runs.get(cold.runId);
  assert.equal(run.spend.day, '2026-11-18');
  assert.ok(run.spend.reserved > callCost({ input_tokens: 2041, output_tokens: 900 }, PRICES['claude-sonnet-5']), 'the second step is reserved above its cost');
  assert.equal(w.spentToday(), 6716 + run.spend.reserved, 'after the cold step: its cost and the reserve of the second');
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(w.spentToday(), 6716 + 13082, 'after the second step: the cost of the two calls');
  assert.equal(w.spentToday(), w.calls.cost);
  assert.equal(done.run.spend.reserved, 0);
  assert.deepEqual(w.calls.sites, ['c0ffee00-site', 'c0ffee00-site'], 'each call is logged with the site');
});

test('a failed or empty second step frees its reserve: only what the calls cost stays counted', async () => {
  const busy = { error: 'The model is busy. Try again in a minute.', ms: 5 };
  const failed = world({ replies: [withUsage(ANSWERS, 1158, 440), withUsage({ data: { findings: [] }, ms: 5 }, 2000, 30), busy] });
  const cold = await failed.engine.cold('3964929');
  assert.equal((await failed.engine.compare('3964929', cold.runId)).status, 'failed');
  assert.equal(failed.spentToday(), failed.calls.cost);
  assert.equal(failed.runs.get(cold.runId).spend.reserved, 0);

  const empty = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, replies: [withUsage(ANSWERS, 1158, 440)] });
  const coldEmpty = await empty.engine.cold('3964929');
  await empty.engine.compare('3964929', coldEmpty.runId);
  assert.equal(empty.spentToday(), 6716, 'no readable linked material: no second call, nothing more counted');
});

test('ten runs started at once on a site with room for one: one starts, nine are refused', async () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-11-01T00:00:00.000Z', from: 'install event' });
  kvs.data.set('spend:2026-11-18', { spent: 950000, events: 0 }); // $0.05 left: one reserve fits, two do not
  const w = world({ kvs, replies: Array(10).fill(ANSWERS) });
  const results = await Promise.all(Array.from({ length: 10 }, () => w.engine.cold('3964929')));
  assert.equal(results.filter((r) => r.status === 'answered').length, 1);
  assert.equal(results.filter((r) => r.refused === 'budget').length, 9);
  assert.equal(w.events.filter((e) => e.startsWith('callModel')).length, 1);
  assert.equal(kvs.data.has('spend:lock'), false, 'the lock is freed');
});

test('Continue of a run started before the spend limit (no spend in its record) adds its cost to today', async () => {
  const w = world({ replies: [withUsage(FINDINGS, 1548, 353)] });
  w.runs.set('oldrun0001', { runId: 'oldrun0001', pageId: '3964929', title: PAGE.title, pageVersion: PAGE.version, status: 'answered', via: 'button', startedAt: '2026-11-18T08:00:00Z', questions: EXPECTED, answers: [{ q: 1, answer: 'a' }, { q: 2, answer: 'b' }] });
  const done = await w.engine.compare('3964929', 'oldrun0001');
  assert.equal(done.status, 'checked');
  assert.equal(w.spentToday(), 6626);
  assert.equal(done.run.spend, undefined, 'the old record keeps its shape');
});

// ---- Each step of a one-click run is taken once, and only as its reserve was counted. ----

// A site installed long ago that has spent `spent` today.
const spentDay = (spent) => {
  const kvs = oldSite();
  kvs.data.set('spend:2026-11-18', { spent, events: 0 });
  return kvs;
};

test('ten compare calls of one run at once: one model call, one result, nine STEP_TAKEN; only the calls are counted', async () => {
  const w = world({ kvs: spentDay(900000), replies: [withUsage(ANSWERS, 1158, 440), withUsage(FINDINGS, 2041, 900)], modelDelayMs: 5 });
  const cold = await w.engine.cold('3964929');
  const results = await Promise.all(Array.from({ length: 10 }, () => w.engine.compare('3964929', cold.runId)));
  assert.equal(w.events.filter((e) => e === 'callModel compare claude-sonnet-5').length, 1);
  assert.equal(results.filter((r) => r.status === 'checked').length, 1);
  assert.equal(results.filter((r) => r.error === STEP_TAKEN).length, 9);
  assert.equal(w.events.filter((e) => e === 'settleSpend').length, 2, 'the cold step and the one compare step');
  assert.equal(w.spentToday(), 900000 + w.calls.cost);
});

test('a warm read: ten calls of step 2 at once make one model call, ten calls of step 3 at once make three', async () => {
  const w = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [withUsage(ANSWERS, 1158, 440), withUsage(WARM_ANSWERS, 2500, 400), ...CHECKS.map((c) => withUsage(c, 2600, 500))], modelDelayMs: 5 });
  const cold = await w.engine.cold('3964929');
  const step2 = await Promise.all(Array.from({ length: 10 }, () => w.engine.compare('3964929', cold.runId)));
  assert.equal(w.events.filter((e) => e === 'callModel warm claude-sonnet-5').length, 1);
  assert.equal(step2.filter((r) => r.status === 'warmed').length, 1);
  assert.equal(step2.filter((r) => r.error === STEP_TAKEN).length, 9);
  const step3 = await Promise.all(Array.from({ length: 10 }, () => w.engine.compare('3964929', cold.runId)));
  assert.equal(w.events.filter((e) => e === 'callModel conflict claude-sonnet-5').length, 3);
  assert.equal(step3.filter((r) => r.status === 'checked').length, 1);
  assert.equal(step3.filter((r) => r.error === STEP_TAKEN).length, 9);
  assert.equal(w.spentToday(), w.calls.cost);
});

test('a step that broke off after it was taken is not taken again: STEP_TAKEN, no model call, the counter stays', async () => {
  const w = world({ replies: [withUsage(ANSWERS, 1158, 440), withUsage(FINDINGS, 2041, 900)] });
  const cold = await w.engine.cold('3964929');
  // The mark of the compare step is there and the run is still answered: the call that took the step broke off.
  w.kvs.data.set(`step:3964929:${cold.runId}:findings`, { at: '2026-11-18T09:00:05.000Z' });
  const spent = w.spentToday();
  assert.deepEqual(await w.engine.compare('3964929', cold.runId), { error: STEP_TAKEN });
  assert.ok(!w.events.some((e) => e.startsWith('callModel compare')));
  assert.equal(w.spentToday(), spent, 'its reserve stays counted');
  assert.equal(w.runs.get(cold.runId).status, 'answered');
});

test('a run whose page changed after its answers were saved is not continued: no model call, the run fails, only the cold call stays counted', async () => {
  const page = { ...PAGE };
  const w = world({ page, replies: [withUsage(ANSWERS, 1158, 440), withUsage(FINDINGS, 2041, 900)] });
  const cold = await w.engine.cold('3964929');
  page.version = 5;
  const res = await w.engine.compare('3964929', cold.runId);
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'The cold read failed: The page changed after its answers were saved. Run a new cold read.');
  assert.ok(!w.events.some((e) => e.startsWith('callModel compare')));
  assert.ok(w.events.includes('claimStep findings'), 'the step is taken, so it is refused once');
  const run = w.runs.get(cold.runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.spend.reserved, 0);
  assert.equal(w.spentToday(), 6716, 'the cost of the cold call');
});

test('a run is not continued on another UTC day: its reserve is freed on its own day', async () => {
  let t = Date.UTC(2026, 10, 18, 23, 59);
  const w = world({ kvs: oldSite(), clock: () => t, replies: [withUsage(ANSWERS, 1158, 440), withUsage(FINDINGS, 2041, 900)] });
  const cold = await w.engine.cold('3964929');
  t = Date.UTC(2026, 10, 19, 0, 1);
  const res = await w.engine.compare('3964929', cold.runId);
  assert.equal(res.error, 'The cold read failed: This cold read can no longer be continued. Run a new cold read.');
  assert.ok(!w.events.some((e) => e.startsWith('callModel compare')));
  assert.equal(w.spentToday(), 6716, 'the day of the reserve keeps only the cold call');
  assert.equal(w.kvs.data.get('spend:2026-11-19'), undefined, 'nothing counted on the new day');
});

test('the cold step reads the questions once: the run takes the path its reserve was counted for', async () => {
  // A second read would give no expected answers (cleared between the reads): the run stays a compare run.
  let reads = 0;
  const w = world({ questions: () => ((reads += 1) === 1 ? EXPECTED : NO_EXPECTED), page: LINKED_PAGE, related: RELATED, replies: [withUsage(ANSWERS, 1158, 440)] });
  const cold = await w.engine.cold('3964929');
  assert.equal(w.events.filter((e) => e === 'getQuestions').length, 1);
  assert.equal(cold.compareWith, 'expected answers');
  const run = w.runs.get(cold.runId);
  assert.equal(expectedOf(run).length, 2);
  assert.equal(run.spend.warm, undefined, 'the reserve of a compare step, not of a warm read');
});

test('the panel resolver passes claimStep of the store to makeAutoRun', () => {
  const src = readFileSync(new URL('../src/resolvers.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bclaimStep\b[^}]*\} from '\.\/store';/);
  const deps = src.match(/makeAutoRun\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  assert.match(deps, /^\s*claimStep,$/m);
});

test('step 3 taken by a person who cannot open one of the sources of step 2: the panel gets the copy, the store the full record', async () => {
  const related = { ...RELATED };
  const w = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related, replies: [ANSWERS, WARM_ANSWERS, ...CHECKS] });
  const cold = await w.engine.cold('3964929');
  await w.engine.compare('3964929', cold.runId);
  // The person of step 3 cannot open page 42: their read finds only REN-1.
  related.related = [];
  related.sources = [RELATED.sources[1]];
  const done = await w.engine.compare('3964929', cold.runId);
  assert.equal(done.status, 'checked');
  assert.equal(done.findings.A, 1);
  assert.equal(done.run.warm.hidden, 1);
  assert.deepEqual(done.run.warm.sources.map((s) => s.issueKey ?? s.pageId), ['REN-1']);
  assert.equal(done.run.warm.answers, undefined);
  assert.equal(done.run.findings[0].note, HIDDEN_NOTE);
  assert.equal(done.run.findings[0].quotes, undefined);
  const stored = w.runs.get(cold.runId);
  assert.equal(stored.warm.hidden, undefined);
  assert.equal(stored.warm.sources.length, 2);
  assert.equal(stored.warm.answers.length, 2);
  assert.ok(stored.findings[0].quotes, 'the record keeps the quotes');
  assert.equal(w.lastRun().warm.answers.length, 2);
  // The same step by a person who sees both sources gets the run as it is.
  const all = world({ kvs: oldSite(), questions: NO_EXPECTED, page: LINKED_PAGE, related: RELATED, replies: [ANSWERS, WARM_ANSWERS, ...CHECKS] });
  const c2 = await all.engine.cold('3964929');
  await all.engine.compare('3964929', c2.runId);
  const d2 = await all.engine.compare('3964929', c2.runId);
  assert.equal(d2.run, all.runs.get(c2.runId));
});
