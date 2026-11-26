// "Load sample handoffs" on the Cold Read space page: a made-up payments team hands over on-call for the week.
// The sample puts five pages into the space (a parent page and four handoffs under it) and two Jira issues into a
// project the person picks; Cold Read runs nothing by itself. Pure: no Forge imports (src/sample-run.js does the
// calls), so the tests check the texts and the record with plain Node.

export const SAMPLE_LABEL = 'cold-read-sample';
export const SAMPLE_PARENT_TITLE = 'Cold Read sample: Payments on-call';
export const MAIN_TITLE = 'On-call handoff: Payments, week 47 (Mira to Jon)';

// A loading record older than this is taken for a load that broke off: Remove sample cleans up what it lists.
export const LOADING_STALE_MS = 2 * 60 * 1000;

// The two Jira issues. The handoff links both; the comment holds the rule the handoff leaves out. Its author in Jira
// is the person who loads the sample, so the comment names Mira itself.
export const SAMPLE_ISSUES = {
  dup: {
    summary: "Duplicate pending charges from Tuesday's billing run",
    comment:
      'Mira, Wed 09:12 UTC: Root cause: I restarted billing-worker at 01:42 while the billing run was still going. ' +
      'On restart it picked the run up from the last checkpoint and sent 41 charges again, and the processor took them as ' +
      'new because our idempotency key includes the attempt number (fix is {FIX}, Payments Core). Until {FIX} ships: ' +
      "don't restart billing-worker while a billing run is in progress. Lag during the run is expected and drains on its " +
      'own, so wait for the run to show COMPLETED on the Billing runs dashboard; if there\'s no progress for 20 min, page ' +
      'Payments Core instead.',
  },
  fix: { summary: 'Fix: idempotency key must not include the attempt number' },
};

// The line of the handoff that Mira fixes after the first cold read (the video and docs/JUDGES.md): the same item,
// edited. {DUP} is the key of the first issue.
export const FIXED_LINE =
  "If billing queue lag goes over 15 min tonight, don't restart billing-worker while the billing run is in progress. " +
  'Lag during the run drains on its own, so wait for the run to show COMPLETED ({DUP}). If there\'s no progress for ' +
  '20 min, page Payments Core. Outside a run, restart billing-worker (see the Restart billing-worker runbook).';

// Text pieces: a string, { issue: 'dup' | 'fix' } (the key, linked to the issue) or { page: title } (a page link).
// A page is a list of blocks: a paragraph (array of pieces), { heading } or { items: [paragraphs] }.
const DUP = { issue: 'dup' };
const FIX = { issue: 'fix' };

const RESTART_LINE = ['If billing queue lag goes over 15 min tonight, restart billing-worker (see the Restart billing-worker runbook).'];
const PROCESSOR_LINE = ['Processor 5xx spike: usually on their side. Check their status page before you page anyone.'];

export const SAMPLE_PAGES = [
  {
    ref: 'main',
    title: MAIN_TITLE,
    blocks: [
      ["Fri 20 Nov. Pager goes to Jon at 18:00 UTC. I'm on leave from tomorrow, back 1 Dec. For history ask Dana or #payments-oncall."],
      ['Jon, welcome back. Quiet week apart from Tuesday night.'],
      { heading: 'Where things are' },
      {
        items: [
          [DUP, ": duplicate pending charges from Tuesday's billing run. All 41 voided Wed morning, Support has the customer list. Ticket stays open until the fix (", FIX, ') ships.'],
          ["Billing runs Wed, Thu, Fri: clean. Tonight's run is bigger than usual (annual plans renew), so expect the lag alert around 01:30."],
          ['Processor cert expires 3 Dec. Payments Core rotates it on Tuesday, nothing for us unless it slips.'],
        ],
      },
      { heading: 'If it fires' },
      { items: [RESTART_LINE, PROCESSOR_LINE], restartItem: 0 },
      { heading: 'Decided' },
      {
        items: [
          ['No customer email for Tuesday. Support answers whoever writes in (agreed with Dana, Thu ops review).'],
          ['No manual re-runs of failed renewals over the weekend. They retry on their own Monday 01:00.'],
        ],
      },
      { heading: 'Done this week' },
      {
        items: [
          ['Voided the 41 duplicates. The list in ', DUP, " is final, don't void again."],
          ['Sent the affected-customer list to Support on Wed. They own the replies.'],
        ],
      },
      { heading: 'Waiting on' },
      {
        items: [
          ['Payments Core: ', FIX, ', the fix for the duplicates. ETA next sprint. Nothing for on-call to do on it.'],
          ['Dana: sending the Tuesday summary to Finance. My draft is in ', DUP, '.'],
        ],
      },
    ],
  },
  {
    // Clean: says nothing the linked issues contradict.
    ref: 'finance',
    title: 'Handoff: Tuesday summary for Finance (Mira to Dana)',
    blocks: [
      ["Fri 20 Nov. I'm on leave from tomorrow, back 1 Dec. Dana takes over the Tuesday summary for Finance."],
      { heading: 'Where it is' },
      { items: [['The draft is written and Dana has it. It covers what happened on Tuesday night (', DUP, ') and the 41 voided duplicates.']] },
      { heading: 'Next' },
      { items: [['Dana: read the draft, then send it to Finance.']] },
      { heading: 'Decided' },
      { items: [['No customer email for Tuesday. Support answers whoever writes in (agreed at Thu ops review).']] },
      { heading: 'Done' },
      { items: [["Voided the 41 duplicates on Wed morning. Don't void again."], ['Sent the affected-customer list to Support on Wed.']] },
      { heading: 'Waiting on' },
      { items: [['Nobody. The fix (', FIX, ') is with Payments Core and is not part of the summary.']] },
    ],
  },
  {
    // Its own finding: the other team's handoff still says to restart billing-worker when a billing run is
    // stuck, against the rule in the comment of the first issue (no restart while a billing run is in progress).
    ref: 'core',
    title: 'On-call handoff: Payments Core, week 47',
    blocks: [
      ['Fri 20 Nov. Core pager changes hands at 18:00 UTC.'],
      { heading: 'Where things are' },
      {
        items: [
          [FIX, ": the fix for Tuesday's duplicate charges (", DUP, '). Not started yet, planned for next sprint.'],
          ['Processor cert expires 3 Dec. The new cert is ready, we rotate it on Tuesday.'],
        ],
      },
      { heading: 'Next' },
      { items: [['If Platform on-call pages us about a stuck billing run tonight, ask them to restart billing-worker.']] },
      { heading: 'Decided' },
      { items: [['The fix ships in the normal release, no hotfix.']] },
      { heading: 'Done this week' },
      { items: [['Got the new processor cert.']] },
      { heading: 'Waiting on' },
      { items: [['Nobody.']] },
    ],
  },
  {
    // Short, with no links: the run ends after the cold read, with the hint to link the issues and pages.
    ref: 'week46',
    title: 'On-call handoff: Payments, week 46 (Jon to Mira)',
    blocks: [
      ["Fri 13 Nov. Pager goes to Mira at 18:00 UTC. I'm on leave next week, back 20 Nov."],
      ['Quiet week. Billing runs all clean.'],
      { heading: 'If it fires' },
      { items: [RESTART_LINE, PROCESSOR_LINE] },
    ],
  },
];

// The parent page: what the sample is and where to start.
const PARENT_BLOCKS = [
  ['Sample handoffs for trying Cold Read. The team, the people and the incident are made up.'],
  ['Start with ', { page: MAIN_TITLE }, '. Click Cold Read under its title, then Run cold read.'],
  ['The sample also added two Jira issues with the label ' + SAMPLE_LABEL + ': ', DUP, ' and ', FIX, '. To remove the sample, open Space apps, then Cold Read, and click Remove sample: it removes the two issues. Then delete this page with its children.'],
];

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

// keys: { dup, fix } - the issue keys; base: the site address ("https://x.atlassian.net"), or none for plain keys.
function piece(p, { keys, base }) {
  if (typeof p === 'string') return escText(p);
  if (p.issue) {
    const key = keys[p.issue];
    return base ? `<a href="${escAttr(`${base}/browse/${key}`)}">${escText(key)}</a>` : escText(key);
  }
  return `<ac:link><ri:page ri:content-title="${escAttr(p.page)}" /><ac:plain-text-link-body><![CDATA[${p.page}]]></ac:plain-text-link-body></ac:link>`;
}

const paragraph = (pieces, ctx) => pieces.map((p) => piece(p, ctx)).join('');

function blocksToStorage(blocks, ctx) {
  return blocks
    .map((b) => {
      if (Array.isArray(b)) return `<p>${paragraph(b, ctx)}</p>`;
      if (b.heading) return `<p><strong>${escText(b.heading)}</strong></p>`;
      return `<ul>${b.items.map((item) => `<li>${paragraph(item, ctx)}</li>`).join('')}</ul>`;
    })
    .join('');
}

const fill = (text, keys) => text.replace(/\{DUP\}/g, keys.dup).replace(/\{FIX\}/g, keys.fix);

// Storage format of every sample page. fixed: the main handoff with FIXED_LINE in place of the restart line.
export function samplePageBodies({ keys, base, fixed = false }) {
  const ctx = { keys, base };
  return SAMPLE_PAGES.map(({ ref, title, blocks }) => {
    const shown = fixed && ref === 'main'
      ? blocks.map((b) => (b.restartItem === undefined ? b : { items: b.items.map((it, i) => (i === b.restartItem ? [fill(FIXED_LINE, keys)] : it)) }))
      : blocks;
    return { ref, title, body: blocksToStorage(shown, ctx) };
  });
}

export const parentPageBody = ({ keys, base }) => blocksToStorage(PARENT_BLOCKS, { keys, base });

export const sampleComment = (keys) => fill(SAMPLE_ISSUES.dup.comment, keys);

// A Jira comment in Atlassian Document Format: one paragraph.
export const adfParagraph = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// The state of a space's sample record: none | loading | loaded | failed. A loading record that is too old is failed.
export function sampleState(record, now = Date.now()) {
  if (!record) return 'none';
  if (record.state === 'loading') return now - Date.parse(record.startedAt) > LOADING_STALE_MS ? 'failed' : 'loading';
  return record.state === 'loaded' ? 'loaded' : 'failed';
}

// What the space page shows of a record: no account IDs, only keys, ids, titles and links.
export function sampleView(record, now = Date.now()) {
  const state = sampleState(record, now);
  if (state === 'none') return { state };
  return {
    state,
    parent: record.parent ? { id: record.parent.id, title: record.parent.title, url: record.parent.url } : null,
    pages: (record.pages ?? []).map(({ id, title, url }) => ({ id, title, url })),
    issues: Object.values(record.issues ?? {}),
    projectId: record.projectId,
    error: state === 'failed' ? record.error ?? 'Loading the sample did not finish.' : undefined,
  };
}

// How the space page offers "Load sample handoffs": the main button in a space with no checked pages, a second
// button under the table otherwise, none once the sample is in the space (then "Remove sample").
export function sampleOffer(pageCount, state) {
  if (state !== 'none') return null;
  return pageCount ? 'secondary' : 'primary';
}

// The pages of the space view: pages with Cold Read questions or runs, plus the sample's handoffs (not the parent).
export function withSamplePages(ids, record) {
  const out = [...ids];
  for (const p of record?.pages ?? []) if (!out.includes(p.id)) out.push(p.id);
  return out;
}
