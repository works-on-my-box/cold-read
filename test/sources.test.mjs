import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFindRelated, makeForViewer } from '../src/sources.js';
import { pageLinks, warmAnswersPrompt, WARM_SOURCES, WARM_SOURCE_CHARS, HIDDEN_NOTE } from '../src/logic.js';

// A fake site: pages by id, issues by key, and what each title lookup finds. Every call is written down.
function site({ pages = {}, issues = {}, titles = {} } = {}) {
  const calls = [];
  const deps = {
    fetchPage: async (id, opts) => {
      calls.push(`page ${id}${opts?.withBody ? ' body' : ''}`);
      const p = pages[id];
      return p ? { id, title: p.title, spaceId: '3932163', text: p.text } : { error: `Confluence returned 404 for page ${id}`, status: 404 };
    },
    fetchIssue: async (key) => {
      calls.push(`issue ${key}`);
      return issues[key] ?? { error: `Jira returned 404 for issue ${key}` };
    },
    pageByTitle: async (title, { spaceKey, spaceId }) => {
      const where = spaceKey ? `key ${spaceKey}` : `id ${spaceId}`;
      calls.push(`title ${title} in ${where}`);
      return titles[`${title} in ${where}`] ?? [];
    },
  };
  return { findRelated: makeFindRelated(deps), calls };
}

const ACME_LOG = { title: 'Acme renewal: email log', text: 'Nov 7: Alex sent the renewal email with the quote to Dana Ruiz.' };
const ACME_PLAN = { title: 'Acme renewal: plan', text: 'Renew for one year at $48,000.' };
const INITECH = { title: 'Handoff: Initech renewal (Oleg to Tom)', text: 'Tom owns the Initech renewal.' };
const REN1 = { key: 'REN-1', summary: 'Send the Acme quote', status: 'Done', labels: [], text: 'Sent to Dana Ruiz on Nov 7.' };
const OWN = { key: 'REN-9', summary: 'Cold Read: 1 class A finding', status: 'To Do', labels: ['cold-read'], text: 'Fix the page.' };

test('the sources are the pages and issues the page links to, as the person can read them', async () => {
  const storage =
    '<p>Sent: <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">REN-1</ac:parameter></ac:structured-macro>, ' +
    'see <ac:link><ri:page ri:space-key="CRLAB" ri:content-title="Acme renewal: email log" /></ac:link> and ' +
    '<ac:link><ri:page ri:content-title="Acme renewal: plan" /></ac:link>. ' +
    'Our own REN-9, this page <a href="/wiki/spaces/CRLAB/pages/3964929/Handoff">itself</a>, COVID-19 and a hidden page ' +
    '<a href="/wiki/spaces/HR/pages/999/Secret">999</a>.</p>';
  // A link by title is looked up in the space the link names, or else in the space of the page.
  const titled = site({
    pages: { 4030465: ACME_LOG, 4030466: ACME_PLAN, 5177345: INITECH },
    issues: { 'REN-1': REN1, 'REN-9': OWN },
    titles: {
      'Acme renewal: email log in key CRLAB': [{ id: '4030465', title: ACME_LOG.title }],
      'Acme renewal: plan in id 3932163': [{ id: '4030466', title: ACME_PLAN.title }],
    },
  });
  const found = await titled.findRelated({ pageId: '3964929', spaceId: '3932163', links: pageLinks(storage) }, { sources: WARM_SOURCES, chars: WARM_SOURCE_CHARS });
  assert.deepEqual(Object.keys(found), ['related', 'relatedIssues', 'sources'], 'no search terms: there is no search');
  assert.deepEqual(found.sources, [{ pageId: '4030465', title: ACME_LOG.title }, { pageId: '4030466', title: ACME_PLAN.title }, { issueKey: 'REN-1', title: REN1.summary }]);
  assert.equal(found.related[0].text, ACME_LOG.text);
  assert.equal(found.relatedIssues[0].text, REN1.text);
  // Not read: the page itself; the hidden page (404) and COVID-19 (no issue) are dropped; Cold Read's own issue is left out.
  assert.ok(!titled.calls.includes('page 3964929 body'), 'the page itself is not a source');
  assert.ok(titled.calls.includes('page 999 body') && titled.calls.includes('issue COVID-19'));
  assert.ok(!titled.calls.includes('page 5177345 body'), 'a page the links do not name is never read');
  assert.equal(titled.calls.filter((c) => c === 'page 4030465 body').length, 1, 'a linked page is read once');
  assert.ok(titled.calls.includes('title Acme renewal: email log in key CRLAB') && titled.calls.includes('title Acme renewal: plan in id 3932163'));
});

test('no links, or links that cannot be read: no sources, and nothing else is read', async () => {
  for (const links of [pageLinks('<p>Nov 7: Alex sent the renewal email.</p>'), pageLinks('<p>See COVID-19 and <a href="/wiki/spaces/HR/pages/999/Secret">this</a>.</p>'), undefined]) {
    const { findRelated, calls } = site({ pages: { 4030465: ACME_LOG, 5177345: INITECH } });
    const found = await findRelated({ pageId: '3964929', spaceId: '3932163', links }, { sources: WARM_SOURCES, chars: WARM_SOURCE_CHARS });
    assert.deepEqual(found, { related: [], relatedIssues: [], sources: [] });
    assert.ok(calls.every((c) => c === 'issue COVID-19' || c === 'page 999 body'), calls.join('; '));
  }
});

test('the agent (no limits): up to five linked pages and five issues of 4000 characters; the button: six of 3000', async () => {
  const pages = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`${100 + i}`, { title: `P${i}`, text: 'x'.repeat(5000) }]));
  const issues = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`ABC-${i + 1}`, { key: `ABC-${i + 1}`, summary: `I${i}`, status: 'Done', labels: [], text: 'y'.repeat(5000) }]));
  const links = { pageIds: Object.keys(pages), pageTitles: [], issueKeys: Object.keys(issues) };
  const { findRelated } = site({ pages, issues });
  const found = await findRelated({ pageId: '1', links });
  assert.equal(found.related.length, 5);
  assert.equal(found.relatedIssues.length, 5);
  assert.equal(found.related[0].text.length, 4000);
  // The one-click run: six in all, taken from pages and issues in turn (pickSources), 3000 characters each.
  const button = await findRelated({ pageId: '1', links }, { sources: WARM_SOURCES, chars: WARM_SOURCE_CHARS });
  assert.deepEqual(button.sources.map((s) => s.pageId ?? s.issueKey), ['100', '101', '102', 'ABC-1', 'ABC-2', 'ABC-3']);
  assert.equal(button.relatedIssues[0].text.length, WARM_SOURCE_CHARS);
});

// The rule of the estimate, written apart from src/logic.js: two ASCII characters a token, a token for each UTF-8 byte
// of every other character.
const byBytes = (s) => Math.ceil(s.replace(/[^\x00-\x7F]/g, '').length / 2) + Buffer.byteLength(s.replace(/[\x00-\x7F]/g, ''), 'utf8');

test('the button: a linked source in another script is cut to its part of the reserve, 1700 tokens with its title and tags; English as before', async () => {
  const ru = 'Передача дел: Дана ждёт ответа по счёту, повторно его не отправлять. '.repeat(60);
  const pages = { 100: { title: 'Передача дел: продление договора', text: ru } };
  const issues = {
    'ABC-1': { key: 'ABC-1', summary: 'Отправить счёт Дане', status: 'Готово', labels: [], text: ru },
    'ABC-2': { key: 'ABC-2', summary: 'Emoji', status: 'Done', labels: [], text: '😀'.repeat(2000) },
    'ABC-3': { key: 'ABC-3', summary: 'English', status: 'Done', labels: [], text: 'y'.repeat(5000) },
  };
  const links = { pageIds: Object.keys(pages), pageTitles: [], issueKeys: Object.keys(issues) };
  const { findRelated } = site({ pages, issues });
  const found = await findRelated({ pageId: '1', links }, { sources: WARM_SOURCES, chars: WARM_SOURCE_CHARS });
  const content = warmAnswersPrompt({ title: 'T', pageText: 'p', questions: [{ id: 'q1', text: 'Q?' }], related: found.related, relatedIssues: found.relatedIssues }).messages[1].content;
  const blocks = [
    ...found.related.map((p) => `<linked_page id="${p.pageId}" title="${p.title}">\n${p.text}\n</linked_page>`),
    ...found.relatedIssues.map((i) => `<jira_issue key="${i.issueKey}" title="${i.title}" status="${i.status}">\n${i.text}\n</jira_issue>`),
  ];
  assert.equal(blocks.length, 4);
  for (const [n, block] of blocks.entries()) {
    assert.ok(content.includes(`\n\n${block}`), 'the block as the request has it');
    const tokens = byBytes(`\n\n${block}`);
    assert.ok(tokens <= 1700, `${block.slice(0, 40)}: ${tokens} tokens`);
    // Cyrillic and emoji are cut by tokens: no shorter than their part; English by characters.
    if (n < 3) assert.ok(tokens > 1690, `${block.slice(0, 40)}: cut no shorter than its part (${tokens})`);
  }
  assert.ok(ru.startsWith(found.related[0].text) && found.related[0].text.length < WARM_SOURCE_CHARS, 'Cyrillic: a start of the text, shorter');
  assert.equal(found.relatedIssues[1].text.length % 2, 0, 'an emoji is not cut in half');
  assert.equal(found.relatedIssues[2].text, 'y'.repeat(WARM_SOURCE_CHARS), 'English: 3000 characters, as before');
  // The agent (no limits) gets the sources cut by characters only, as before.
  const agent = await findRelated({ pageId: '1', links });
  assert.equal(agent.related[0].text, ru.slice(0, 4000));
});

// What a run shows to the person who asks: each linked source is checked at once, an issue by canSeeIssue, a page
// without its body; one they cannot open gives a copy without what came with the linked sources.
test('forViewer: every source opens - the run itself; one does not - the copy of runForViewer', async () => {
  const run = {
    runId: 'mwrun00001',
    status: 'checked',
    warm: { links: 2, sources: [{ pageId: '42', title: 'Acme renewal notes', used: true }, { issueKey: 'REN-1', title: 'Send quote', used: true }], answers: [{ q: 1, answer: 'a', sources: [] }] },
    findings: [{ q: 1, questionId: 'h1', verdict: 'A', note: 'n', questions: [1], quotes: { page: 'p', source: { issueKey: 'REN-1', quote: 's' } } }],
  };
  const make = ({ pages, issues }) => {
    const calls = [];
    let inFlight = 0;
    let most = 0;
    const wait = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };
    const forViewer = makeForViewer({
      fetchPage: async (id, opts) => (calls.push(`page ${id}${opts?.withBody ? ' body' : ''}`), await wait(), pages.includes(id) ? { id } : { error: `Confluence returned 404 for page ${id}`, status: 404 }),
      canSeeIssue: async (key) => (calls.push(`issue ${key}`), await wait(), issues.includes(key)),
    });
    return { forViewer, calls, most: () => most };
  };
  const all = make({ pages: ['42'], issues: ['REN-1'] });
  assert.equal(await all.forViewer(run), run);
  assert.deepEqual(all.calls, ['page 42', 'issue REN-1'], 'a page without its body');
  assert.equal(all.most(), 2, 'both at once');
  const one = make({ pages: ['42'], issues: [] });
  const shown = await one.forViewer(run);
  assert.equal(shown.warm.hidden, 1);
  assert.deepEqual(shown.warm.sources, [run.warm.sources[0]]);
  assert.equal(shown.warm.answers, undefined);
  assert.equal(shown.findings[0].note, HIDDEN_NOTE);
  // A run without a warm read asks nothing.
  const none = make({ pages: [], issues: [] });
  const compared = { runId: 'mwrun00002', findings: [] };
  assert.equal(await none.forViewer(compared), compared);
  assert.deepEqual(none.calls, []);
});

test('forViewer is applied where a run is shown: the panel state, get-cold-read-status and the Jira issue; the record gets the Jira key', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const resolvers = read('../src/resolvers.js');
  assert.match(resolvers, /const shown = lastRun \? await forViewer\(lastRun\) : null;/);
  assert.match(resolvers, /lastRun: shown, interrupted: interruptedRun\(pending, lastRun\)/);
  assert.match(resolvers, /const fields = findingsIssue\(await forViewer\(run\), \{ pageTitle: page\.title, pageUrl: page\.url \}\);/);
  assert.match(resolvers, /await recordJira\(run, jira\);/, 'the record from the store, not the copy');
  const actions = read('../src/index.js');
  assert.match(actions, /const shown = await forViewer\(run\);/);
  assert.match(actions, /findings: \(shown\.findings \?\? \[\]\)/);
  assert.match(actions, /comparedWith: run\.questions\.some/);
  assert.match(read('../src/related.js'), /export const forViewer = makeForViewer\(\{ fetchPage, canSeeIssue \}\);/);
  assert.match(read('../src/jira.js'), /export async function canSeeIssue\(key\) \{\s*const res = await call\(route`\/rest\/api\/3\/issue\/\$\{key\}\?fields=summary`\);\s*return res\.ok;\s*\}/);
});
