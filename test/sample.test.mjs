import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SAMPLE_LABEL,
  SAMPLE_PARENT_TITLE,
  MAIN_TITLE,
  SAMPLE_PAGES,
  SAMPLE_ISSUES,
  FIXED_LINE,
  LOADING_STALE_MS,
  samplePageBodies,
  parentPageBody,
  sampleComment,
  sampleState,
  sampleView,
  withSamplePages,
  sampleOffer,
} from '../src/sample.js';
import { makeSample, REMOVED_COMMENT } from '../src/sample-run.js';
import { makeFindRelated } from '../src/sources.js';
import { storageToText, pageLinks, hasLinks, adfToText, pageState } from '../src/logic.js';

const KEYS = { dup: 'REN-20', fix: 'REN-21' };
const BASE = 'https://example.atlassian.net';
const bodies = (opts = {}) => Object.fromEntries(samplePageBodies({ keys: KEYS, base: BASE, ...opts }).map((p) => [p.ref, p]));

// The handoff of the video as the reader read it in the runs of 22 Nov 2026 (8355841 v2, REN-7 for the issue, OPS-91
// for the fix), with the lead Dana in place of Priya and three lines changed before the sample was run later that day:
// Friday the 20th (21 Nov 2026 is a Saturday), the restart line as a sentence for tonight, and nothing for on-call on
// the fix.
const MEASURED_HANDOFF = [
  "Fri 21 Nov. Pager goes to Jon at 18:00 UTC. I'm on leave from tomorrow, back 1 Dec. For history ask Priya or #payments-oncall.",
  'Jon, welcome back. Quiet week apart from Tuesday night.',
  'Where things are',
  "REN-7: duplicate pending charges from Tuesday's billing run. All 41 voided Wed morning, Support has the customer list. Ticket stays open until the fix (OPS-91) ships.",
  "Billing runs Wed, Thu, Fri: clean. Tonight's run is bigger than usual (annual plans renew), so expect the lag alert around 01:30.",
  'Processor cert expires 3 Dec. Payments Core rotates it on Tuesday, nothing for us unless it slips.',
  'If it fires',
  'Billing queue lag > 15 min: restart billing-worker (runbook: Restart billing-worker).',
  'Processor 5xx spike: usually on their side. Check their status page before you page anyone.',
  'Decided',
  'No customer email for Tuesday. Support answers whoever writes in (agreed with Priya, Thu ops review).',
  'No manual re-runs of failed renewals over the weekend. They retry on their own Monday 01:00.',
  'Done this week',
  "Voided the 41 duplicates. The list in REN-7 is final, don't void again.",
  'Sent the affected-customer list to Support on Wed. They own the replies.',
  'Waiting on',
  'Payments Core: OPS-91, the fix for the duplicates. ETA next sprint.',
  'Priya: sending the Tuesday summary to Finance. My draft is in REN-7.',
];
const RESTART = 'If billing queue lag goes over 15 min tonight, restart billing-worker (see the Restart billing-worker runbook).';
const OPS91 = 'Payments Core: REN-21, the fix for the duplicates. ETA next sprint. Nothing for on-call to do on it.';
const FRIDAY = "Fri 20 Nov. Pager goes to Jon at 18:00 UTC. I'm on leave from tomorrow, back 1 Dec. For history ask Dana or #payments-oncall.";

test('sample: the main handoff reads as measured on 22 Nov 2026, keys of the new issues, Dana, only the date, restart and fix lines changed', () => {
  const expected = MEASURED_HANDOFF.map((l) => l.replace(/REN-7/g, KEYS.dup).replace(/OPS-91/g, KEYS.fix).replace(/Priya/g, 'Dana'));
  expected[0] = FRIDAY;
  expected[7] = RESTART;
  expected[16] = OPS91;
  const text = storageToText(bodies().main.body);
  assert.equal(text, expected.join('\n'));
  assert.equal(bodies().main.title, MAIN_TITLE);
  // the same text with plain keys (no site address): links do not change what the reader reads
  assert.equal(storageToText(samplePageBodies({ keys: KEYS })[0].body), text);
});

test('sample: the restart line is a sentence that can be quoted, and the fix line asks nothing of on-call', () => {
  assert.ok(!RESTART.includes('>') && !RESTART.includes(':'));
  assert.match(RESTART, /tonight, restart billing-worker/);
  assert.match(OPS91, /Nothing for on-call to do on it\.$/);
});

test('sample: links of every handoff - issue links to the site, the Core handoff links both issues and no page, week 46 none', () => {
  const b = bodies();
  assert.deepEqual(pageLinks(b.main.body), { pageIds: [], pageTitles: [], issueKeys: [KEYS.dup, KEYS.fix] });
  assert.match(b.main.body, /<a href="https:\/\/example\.atlassian\.net\/browse\/REN-20">REN-20<\/a>/);
  assert.deepEqual(pageLinks(b.finance.body), { pageIds: [], pageTitles: [], issueKeys: [KEYS.dup, KEYS.fix] });
  assert.deepEqual(pageLinks(b.core.body), { pageIds: [], pageTitles: [], issueKeys: [KEYS.fix, KEYS.dup] });
  assert.equal(hasLinks(pageLinks(b.week46.body)), false);
  assert.deepEqual(
    SAMPLE_PAGES.map((p) => p.title),
    [MAIN_TITLE, 'Handoff: Tuesday summary for Finance (Mira to Dana)', 'On-call handoff: Payments Core, week 47', 'On-call handoff: Payments, week 46 (Jon to Mira)'],
  );
});

test('sample: the Core handoff word for word - its Next line still says to restart billing-worker', () => {
  assert.equal(
    storageToText(bodies().core.body),
    [
      'Fri 20 Nov. Core pager changes hands at 18:00 UTC.',
      'Where things are',
      "REN-21: the fix for Tuesday's duplicate charges (REN-20). Not started yet, planned for next sprint.",
      'Processor cert expires 3 Dec. The new cert is ready, we rotate it on Tuesday.',
      'Next',
      'If Platform on-call pages us about a stuck billing run tonight, ask them to restart billing-worker.',
      'Decided',
      'The fix ships in the normal release, no hotfix.',
      'Done this week',
      'Got the new processor cert.',
      'Waiting on',
      'Nobody.',
    ].join('\n'),
  );
  assert.equal(bodies().core.title, 'On-call handoff: Payments Core, week 47');
  // the comment of the first issue forbids what the Next line asks for
  assert.match(sampleComment(KEYS), /don't restart billing-worker while a billing run is in progress/);
});

test('sample: the clean handoff word for word, every Friday a Friday of 2026, and no Priya', () => {
  assert.equal(
    storageToText(bodies().finance.body),
    [
      "Fri 20 Nov. I'm on leave from tomorrow, back 1 Dec. Dana takes over the Tuesday summary for Finance.",
      'Where it is',
      'The draft is written and Dana has it. It covers what happened on Tuesday night (REN-20) and the 41 voided duplicates.',
      'Next',
      'Dana: read the draft, then send it to Finance.',
      'Decided',
      'No customer email for Tuesday. Support answers whoever writes in (agreed at Thu ops review).',
      'Done',
      "Voided the 41 duplicates on Wed morning. Don't void again.",
      'Sent the affected-customer list to Support on Wed.',
      'Waiting on',
      'Nobody. The fix (REN-21) is with Payments Core and is not part of the summary.',
    ].join('\n'),
  );
  const texts = samplePageBodies({ keys: KEYS }).map((p) => `${p.title}\n${storageToText(p.body)}`).join('\n');
  const fridays = [...texts.matchAll(/Fri (\d+) Nov/g)].map((m) => Number(m[1]));
  assert.deepEqual(fridays, [20, 20, 20, 13]);
  for (const d of fridays) assert.equal(new Date(Date.UTC(2026, 10, d)).getUTCDay(), 5);
  assert.match(storageToText(bodies().week46.body), /back 20 Nov\./);
  assert.doesNotMatch(`${texts}\n${storageToText(parentPageBody({ keys: KEYS }))}`, /Priya/);
});

test('sample: the fixed line takes the place of the restart line in the same item, and the rest stays', () => {
  const before = storageToText(bodies().main.body).split('\n');
  const after = storageToText(bodies({ fixed: true }).main.body).split('\n');
  const fixed = FIXED_LINE.replace('{DUP}', KEYS.dup);
  assert.equal(after.length, before.length);
  assert.equal(after[7], fixed);
  assert.deepEqual(after.filter((_, i) => i !== 7), before.filter((_, i) => i !== 7));
  assert.ok(fixed.startsWith('If billing queue lag goes over 15 min tonight, '));
  assert.match(fixed, /don't restart billing-worker while the billing run is in progress/);
  assert.deepEqual(pageLinks(bodies({ fixed: true }).main.body).issueKeys, [KEYS.dup, KEYS.fix]);
  // the other handoffs keep the old line
  assert.match(storageToText(bodies({ fixed: true }).week46.body), /tonight, restart billing-worker/);
});

test('sample: the comment is the measured comment of the issue, with its author and the key of the fix', () => {
  const measured =
    "Root cause: I restarted billing-worker at 01:42 while the billing run was still going. On restart it picked the run up from the last checkpoint and sent 41 charges again, and the processor took them as new because our idempotency key includes the attempt number (fix is OPS-91, Payments Core). Until OPS-91 ships: don't restart billing-worker while a billing run is in progress. Lag during the run is expected and drains on its own, so wait for the run to show COMPLETED on the Billing runs dashboard; if there's no progress for 20 min, page Payments Core instead.";
  assert.equal(sampleComment(KEYS), `Mira, Wed 09:12 UTC: ${measured.replace(/OPS-91/g, KEYS.fix)}`);
  assert.equal(SAMPLE_ISSUES.dup.summary, "Duplicate pending charges from Tuesday's billing run");
  assert.equal(SAMPLE_ISSUES.fix.summary, 'Fix: idempotency key must not include the attempt number');
});

test('sample: the parent page says it is a sample and links the main handoff and both issues', () => {
  const body = parentPageBody({ keys: KEYS, base: BASE });
  const text = storageToText(body);
  assert.match(text, /made up/);
  assert.match(text, /Start with On-call handoff: Payments, week 47 \(Mira to Jon\)\./);
  assert.match(text, new RegExp(`label ${SAMPLE_LABEL}: REN-20 and REN-21`));
  assert.match(text, /click Remove sample: it removes the two issues\. Then delete this page with its children\.$/);
  assert.deepEqual(pageLinks(body).pageTitles, [{ title: MAIN_TITLE }]);
});

test('sample: docs/JUDGES.md gives the restart line, the fixed line and the Next line of the Core handoff of the code word for word', () => {
  const judges = readFileSync(new URL('../docs/JUDGES.md', import.meta.url), 'utf8');
  assert.ok(judges.includes(`> ${FIXED_LINE.replace('{DUP}', 'KEY')}`));
  assert.ok(judges.includes(`replace the line "${RESTART}"`));
  assert.ok(judges.includes(`**${MAIN_TITLE}**`));
  assert.ok(judges.includes(`"${SAMPLE_PARENT_TITLE}"`) && judges.includes(`\`${SAMPLE_LABEL}\``));
  // the Next line of the Core handoff, as the code writes it
  const core = storageToText(bodies().core.body).split('\n');
  const next = core[core.indexOf('Next') + 1];
  assert.match(next, /restart billing-worker/);
  assert.ok(judges.includes(`**${bodies().core.title}**`));
  assert.ok(judges.includes(`Under "Next" it says "${next}"`));
});

test('sample: an issue labelled cold-read-sample is a source of the warm read (only cold-read is left out)', async () => {
  const findRelated = makeFindRelated({
    fetchPage: async () => ({ error: 'none' }),
    fetchIssue: async (key) => ({ key, summary: SAMPLE_ISSUES.dup.summary, status: 'To Do', labels: [SAMPLE_LABEL], text: sampleComment(KEYS) }),
    pageByTitle: async () => [],
  });
  const found = await findRelated({ pageId: '1', spaceId: '2', links: pageLinks(bodies().main.body) }, { sources: 6, chars: 3000 });
  assert.deepEqual(found.sources.map((s) => s.issueKey), [KEYS.dup, KEYS.fix]);
});

test('sample: state of the record, a stale load is failed, and the view holds no people', () => {
  const now = Date.parse('2026-11-22T04:00:00Z');
  assert.equal(sampleState(undefined, now), 'none');
  assert.equal(sampleState({ state: 'loading', startedAt: new Date(now - 1000).toISOString() }, now), 'loading');
  assert.equal(sampleState({ state: 'loading', startedAt: new Date(now - LOADING_STALE_MS - 1).toISOString() }, now), 'failed');
  assert.equal(sampleState({ state: 'loaded' }, now), 'loaded');
  assert.equal(sampleState({ state: 'failed' }, now), 'failed');
  const view = sampleView({ state: 'loaded', projectId: '10000', issues: { dup: 'REN-20', fix: 'REN-21' }, parent: { id: '9', title: 'P', url: 'u' }, pages: [{ ref: 'main', id: '10', title: 'M', url: 'm' }] }, now);
  assert.deepEqual(view, { state: 'loaded', parent: { id: '9', title: 'P', url: 'u' }, pages: [{ id: '10', title: 'M', url: 'm' }], issues: ['REN-20', 'REN-21'], projectId: '10000', error: undefined });
  assert.deepEqual(withSamplePages(['10', '7'], { pages: [{ id: '10' }, { id: '11' }] }), ['10', '7', '11']);
  assert.deepEqual(withSamplePages(['7'], undefined), ['7']);
  assert.deepEqual(pageState(undefined, 1), { key: 'none', label: 'Not checked yet' });
});

// A fake site for makeSample: issues, pages and the record; every call is written down.
// closeResult: what closeIssue gives for a key (closed by default); logs: the lines of the remove log.
function fakeSite({ deleteStatus = {}, closeResult = {}, titles = [], failPage = null, failIssue = false } = {}) {
  const calls = [];
  const logs = [];
  const store = {};
  let n = 19;
  let id = 100;
  const deps = {
    now: () => Date.parse('2026-11-22T04:00:00Z'),
    createIssue: async ({ projectId, summary, labels }) => {
      calls.push(`issue ${projectId} ${summary} ${labels.join(',')}`);
      if (failIssue && summary.startsWith('Fix')) return { error: 'Jira returned 400 for the new issue.' };
      n += 1;
      return { key: `REN-${n}` };
    },
    addComment: async (key, adf) => {
      calls.push(`comment ${key} ${adfToText(adf)}`);
      return { ok: true };
    },
    deleteIssue: async (key) => {
      calls.push(`delete ${key}`);
      const status = deleteStatus[key] ?? 204;
      return status === 204 ? { ok: true } : { status, error: `Jira returned ${status}` };
    },
    closeIssue: async (key, adf) => {
      calls.push(`close ${key} ${adfToText(adf)}`);
      return closeResult[key] ?? { ok: true, closed: true };
    },
    pageByTitle: async (title, { spaceId }) => {
      calls.push(`title ${title} in ${spaceId}`);
      return titles.includes(title) ? [{ id: '1', title }] : [];
    },
    createPage: async ({ spaceId, parentId, title, body }) => {
      calls.push(`page ${title} under ${parentId ?? 'home'} in ${spaceId}`);
      if (title === failPage) return { error: `Confluence returned 400 for the new page "${title}".`, status: 400 };
      id += 1;
      return { id: String(id), title, base: `${BASE}/wiki`, url: `${BASE}/wiki/spaces/CRLAB/pages/${id}`, body };
    },
    getRecord: async (spaceId) => store[spaceId],
    setRecord: async (spaceId, record) => {
      store[spaceId] = JSON.parse(JSON.stringify(record));
    },
    deleteRecord: async (spaceId) => {
      calls.push(`forget ${spaceId}`);
      delete store[spaceId];
    },
    setSpaceJiraProject: async (spaceId, projectId) => calls.push(`last project ${projectId} in ${spaceId}`),
    log: (line) => logs.push(line),
  };
  return { deps, calls, store, logs };
}

test('sample load: issues first, then the parent and the four handoffs as the person, a record of keys and ids', async () => {
  const site = fakeSite();
  const pages = [];
  const createPage = site.deps.createPage;
  site.deps.createPage = async (p) => {
    pages.push(p);
    return createPage(p);
  };
  const res = await makeSample(site.deps).load({ spaceId: '3932163', projectId: '10000' });
  assert.equal(res.error, undefined);
  assert.equal(res.sample.state, 'loaded');
  assert.deepEqual(site.calls.slice(0, 4), [
    `title ${SAMPLE_PARENT_TITLE} in 3932163`,
    `issue 10000 ${SAMPLE_ISSUES.dup.summary} ${SAMPLE_LABEL}`,
    `issue 10000 ${SAMPLE_ISSUES.fix.summary} ${SAMPLE_LABEL}`,
    `comment REN-20 ${sampleComment(KEYS)}`,
  ]);
  assert.equal(site.calls[4], `page ${SAMPLE_PARENT_TITLE} under home in 3932163`);
  assert.equal(site.calls[5], `page ${MAIN_TITLE} under 101 in 3932163`);
  assert.equal(site.calls.filter((c) => c.endsWith('under 101 in 3932163')).length, 4);
  assert.equal(site.calls.at(-1), 'last project 10000 in 3932163');
  // the handoffs link the issues on the site the parent page is on
  assert.match(pages[1].body, /<a href="https:\/\/example\.atlassian\.net\/browse\/REN-20">REN-20<\/a>/);
  const record = site.store['3932163'];
  assert.equal(record.state, 'loaded');
  assert.deepEqual(record.issues, KEYS);
  assert.deepEqual(record.parent, { id: '101', title: SAMPLE_PARENT_TITLE, url: `${BASE}/wiki/spaces/CRLAB/pages/101` });
  assert.deepEqual(record.pages.map((p) => p.ref), ['main', 'finance', 'core', 'week46']);
  assert.deepEqual(res.sample.pages.map((p) => p.title), SAMPLE_PAGES.map((p) => p.title));
  assert.equal(typeof record.ms.all, 'number');
  assert.doesNotMatch(JSON.stringify(record), /accountId|ownerId/);
});

test('sample load: a second click finds the sample loaded and creates nothing', async () => {
  const site = fakeSite();
  const sample = makeSample(site.deps);
  await sample.load({ spaceId: '3932163', projectId: '10000' });
  const made = site.calls.length;
  const again = await sample.load({ spaceId: '3932163', projectId: '10000' });
  assert.equal(again.already, true);
  assert.equal(site.calls.length, made);
});

test('sample load: an existing parent page of an earlier sample stops it before anything is created', async () => {
  const site = fakeSite({ titles: [SAMPLE_PARENT_TITLE] });
  const res = await makeSample(site.deps).load({ spaceId: '3932163', projectId: '10000' });
  assert.match(res.error, /already has a page named "Cold Read sample: Payments on-call"\. Delete it with its child pages/);
  assert.deepEqual(site.calls, [`title ${SAMPLE_PARENT_TITLE} in 3932163`]);
  assert.equal(site.store['3932163'], undefined);
});

test('sample load: a refused step keeps what was made in the record, and Remove sample takes it away', async () => {
  const site = fakeSite({ failPage: 'On-call handoff: Payments Core, week 47' });
  const sample = makeSample(site.deps);
  const res = await sample.load({ spaceId: '3932163', projectId: '10000' });
  assert.match(res.error, /Confluence returned 400/);
  assert.equal(res.sample.state, 'failed');
  const record = site.store['3932163'];
  assert.equal(record.state, 'failed');
  assert.deepEqual(record.issues, KEYS);
  assert.equal(record.pages.length, 3);
  const blocked = await sample.load({ spaceId: '3932163', projectId: '10000' });
  assert.match(blocked.error, /Click Remove sample first/);
  const removed = await sample.remove({ spaceId: '3932163' });
  assert.deepEqual(removed.removed.deleted, ['REN-20', 'REN-21']);
  assert.equal(removed.pagesLeft.title, SAMPLE_PARENT_TITLE);
  assert.equal(site.store['3932163'], undefined);
});

test('sample load: an issue that cannot be created keeps the other one in the record', async () => {
  const site = fakeSite({ failIssue: true });
  const res = await makeSample(site.deps).load({ spaceId: '3932163', projectId: '10000' });
  assert.match(res.error, /Jira returned 400/);
  assert.deepEqual(site.store['3932163'].issues, { dup: 'REN-20' });
  assert.ok(!site.calls.some((c) => c.startsWith('page ')));
});

test('sample load: a load still running is not started twice; a broken-off one can be removed', async () => {
  const site = fakeSite();
  site.store['3932163'] = { state: 'loading', startedAt: new Date(site.deps.now() - 1000).toISOString(), issues: {}, pages: [] };
  const sample = makeSample(site.deps);
  assert.match((await sample.load({ spaceId: '3932163', projectId: '10000' })).error, /is loading/);
  assert.match((await sample.remove({ spaceId: '3932163' })).error, /is loading/);
  site.store['3932163'].startedAt = new Date(site.deps.now() - LOADING_STALE_MS - 1).toISOString();
  const removed = await sample.remove({ spaceId: '3932163' });
  assert.equal(removed.pagesLeft, null);
  assert.equal(site.store['3932163'], undefined);
});

test('sample remove: issues deleted as the person; without the right closed with a comment; pages left with the line', async () => {
  const site = fakeSite({ deleteStatus: { 'REN-21': 403 } });
  const sample = makeSample(site.deps);
  await sample.load({ spaceId: '3932163', projectId: '10000' });
  const res = await sample.remove({ spaceId: '3932163' });
  assert.deepEqual(res.removed, { deleted: ['REN-20'], missing: [], closed: ['REN-21'], commented: [], failed: [] });
  assert.ok(site.calls.includes(`close REN-21 ${REMOVED_COMMENT}`));
  assert.deepEqual(res.pagesLeft, { id: '101', title: SAMPLE_PARENT_TITLE, url: `${BASE}/wiki/spaces/CRLAB/pages/101`, count: 5 });
  assert.equal(site.store['3932163'], undefined);
  assert.ok(!site.calls.some((c) => c.startsWith('delete page')));
  // an issue Jira does not find (already gone, or not visible to the person) is not found, not deleted; another
  // refusal is reported
  const other = fakeSite({ deleteStatus: { 'REN-20': 404, 'REN-21': 500 } });
  const s2 = makeSample(other.deps);
  await s2.load({ spaceId: '1', projectId: '10000' });
  assert.deepEqual((await s2.remove({ spaceId: '1' })).removed, { deleted: [], missing: ['REN-20'], closed: [], commented: [], failed: ['REN-21'] });
  assert.ok(!other.calls.some((c) => c.startsWith('close ')), 'only a 401 or 403 is closed');
  // loads again after removal once the pages are gone
  const s3 = makeSample(fakeSite().deps);
  assert.deepEqual((await s3.remove({ spaceId: '1' })).removed, { deleted: [], missing: [], closed: [], commented: [], failed: [] });
});

test('sample remove: an issue that may not be deleted and has no done transition is commented, not closed; a failed comment is reported', async () => {
  const site = fakeSite({ deleteStatus: { 'REN-20': 403, 'REN-21': 401 }, closeResult: { 'REN-20': { ok: true, closed: false }, 'REN-21': { error: 'Jira returned 403 for a comment on REN-21.' } } });
  const sample = makeSample(site.deps);
  await sample.load({ spaceId: '3932163', projectId: '10000' });
  const res = await sample.remove({ spaceId: '3932163' });
  assert.deepEqual(res.removed, { deleted: [], missing: [], closed: [], commented: ['REN-20'], failed: ['REN-21'] });
  assert.ok(site.calls.includes(`close REN-20 ${REMOVED_COMMENT}`) && site.calls.includes(`close REN-21 ${REMOVED_COMMENT}`));
  assert.match(site.logs.at(-1), / deleted= missing= closed= commented=REN-20 failed=REN-21 /);
  const space = readFileSync(new URL('../src/frontend/space.jsx', import.meta.url), 'utf8');
  for (const line of [
    'Deleted Jira issues: {removed.deleted.join(\', \')}.',
    'Not found in Jira (already deleted, or you cannot see them): {removed.missing.join(\', \')}.',
    'Closed, with a comment (you may not delete issues in this project): {removed.closed.join(\', \')}.',
    'Commented, not closed (no transition to a done status for you here): {removed.commented.join(\', \')}.',
    'Could not delete or close: {removed.failed.join(\', \')}.',
  ]) assert.ok(space.includes(line), line);
  assert.ok(space.includes("appearance={removed.failed.length || removed.commented.length || removed.missing.length ? 'warning' : 'success'}"));
});

test('sample: the space page offers the sample in an empty space and, as a second button, in a space with pages', () => {
  const src = readFileSync(new URL('../src/frontend/space.jsx', import.meta.url), 'utf8');
  assert.equal(sampleOffer(0, 'none'), 'primary');
  assert.equal(sampleOffer(3, 'none'), 'secondary');
  for (const state of ['loading', 'loaded', 'failed']) {
    assert.equal(sampleOffer(0, state), null);
    assert.equal(sampleOffer(3, state), null);
  }
  assert.match(src, /\{offer === 'primary' \? \([\s\S]*?<SampleLoader primary onDone=\{done\} \/>/);
  assert.match(src, /\{offer === 'secondary' \? \([\s\S]*?<SampleLoader onDone=\{done\} \/>/);
  assert.match(src, /appearance=\{primary \? 'primary' : 'default'\}/);
  assert.match(src, /Cold Read has no permission to delete pages\. Open [\s\S]*? and delete this page with its children/);
  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  const scopes = /scopes:\n((?:\s+- .+\n)+)/.exec(manifest)[1].trim().split(/\n\s*- /).map((s) => s.replace(/^- /, '').trim());
  assert.deepEqual(scopes, ['read:page:confluence', 'write:page:confluence', 'search:confluence', 'storage:app', 'read:jira-work', 'write:jira-work']);
  assert.doesNotMatch(manifest, /compatibility|delete:/);
});
