// Loading and removing the sample of src/sample.js. Every Confluence and Jira call runs as the person who clicks
// (src/resolvers.js passes them in), so Confluence and Jira check what they may create and delete. No Forge imports
// here: the tests pass fakes. (The .js extension lets plain Node load this file in the tests.)
import {
  SAMPLE_ISSUES,
  SAMPLE_LABEL,
  SAMPLE_PARENT_TITLE,
  sampleState,
  sampleView,
  samplePageBodies,
  parentPageBody,
  sampleComment,
  adfParagraph,
} from './sample.js';

export const REMOVED_COMMENT = 'Cold Read sample removed';

// deps: createIssue({ projectId, summary, labels }) -> { key } | { error }; addComment(key, adf) -> { ok } | { error };
// deleteIssue(key) -> { ok } | { status, error }; closeIssue(key, adf) -> { ok, closed } | { error };
// pageByTitle(title, { spaceId }) -> [{ id }] | { error }; createPage({ spaceId, parentId, title, body }) ->
// { id, title, url, base } | { error }; getRecord(spaceId), setRecord(spaceId, record), deleteRecord(spaceId);
// setSpaceJiraProject(spaceId, projectId); now() -> ms; log(line).
export function makeSample(deps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  async function load({ spaceId, projectId }) {
    if (!/^\d{1,20}$/.test(String(spaceId ?? ''))) return { error: 'Open the Cold Read page of a space.' };
    if (!/^\d{1,20}$/.test(String(projectId ?? ''))) return { error: 'Choose a Jira project.' };

    const existing = await deps.getRecord(spaceId);
    const state = sampleState(existing, now());
    if (state === 'loaded') return { sample: sampleView(existing, now()), already: true };
    if (state === 'loading') return { error: 'The sample is loading. Refresh this page in a minute.' };
    if (state === 'failed') return { error: 'The last sample did not finish loading. Click Remove sample first.', sample: sampleView(existing, now()) };

    const found = await deps.pageByTitle(SAMPLE_PARENT_TITLE, { spaceId });
    if (found.error) return { error: found.error };
    if (found.length) {
      return { error: `This space already has a page named "${SAMPLE_PARENT_TITLE}". Delete it with its child pages, then load the sample again.` };
    }

    const started = now();
    const record = { state: 'loading', spaceId: String(spaceId), projectId: String(projectId), startedAt: new Date(started).toISOString(), issues: {}, pages: [] };
    await deps.setRecord(spaceId, record);
    const ms = {};
    const fail = async (error) => {
      const failed = { ...record, state: 'failed', error: String(error).slice(0, 300) };
      await deps.setRecord(spaceId, failed);
      log(`sample load failed space=${spaceId} issues=${Object.values(record.issues).join(',')} pages=${record.pages.length + (record.parent ? 1 : 0)}`);
      return { error: failed.error, sample: sampleView(failed, now()) };
    };

    // 1. The two issues, then the comment with the rule.
    let t = now();
    const [dup, fix] = await Promise.all(
      ['dup', 'fix'].map((ref) => deps.createIssue({ projectId: String(projectId), summary: SAMPLE_ISSUES[ref].summary, labels: [SAMPLE_LABEL] })),
    );
    if (dup.key) record.issues.dup = dup.key;
    if (fix.key) record.issues.fix = fix.key;
    if (dup.error || fix.error) return fail(dup.error ?? fix.error);
    const keys = { dup: dup.key, fix: fix.key };
    const comment = await deps.addComment(keys.dup, adfParagraph(sampleComment(keys)));
    if (comment.error) return fail(comment.error);
    ms.issues = now() - t;
    await deps.setRecord(spaceId, record);

    // 2. The parent page; its address gives the links of the handoffs.
    t = now();
    const parent = await deps.createPage({ spaceId, title: SAMPLE_PARENT_TITLE, body: parentPageBody({ keys }) });
    if (parent.error) return fail(parent.error);
    record.parent = { id: parent.id, title: parent.title, url: parent.url };
    const base = parent.base ? new URL(parent.base).origin : undefined;

    // 3. The main handoff first (the others link to it), then the other three.
    const bodies = samplePageBodies({ keys, base });
    const create = async ({ ref, title, body }) => {
      const page = await deps.createPage({ spaceId, parentId: parent.id, title, body });
      if (!page.error) record.pages.push({ ref, id: page.id, title: page.title, url: page.url });
      return page;
    };
    const main = await create(bodies[0]);
    if (main.error) return fail(main.error);
    const rest = await Promise.all(bodies.slice(1).map(create));
    const broken = rest.find((p) => p.error);
    if (broken) return fail(broken.error);
    record.pages.sort((x, y) => bodies.findIndex((b) => b.ref === x.ref) - bodies.findIndex((b) => b.ref === y.ref));
    ms.pages = now() - t;

    const loaded = { ...record, state: 'loaded', loadedAt: new Date(now()).toISOString(), ms: { ...ms, all: now() - started } };
    await deps.setRecord(spaceId, loaded);
    await deps.setSpaceJiraProject(spaceId, String(projectId));
    log(`sample load space=${spaceId} ms=${loaded.ms.all} issues_ms=${ms.issues} pages_ms=${ms.pages} issues=${keys.dup},${keys.fix} pages=${loaded.pages.length + 1}`);
    return { sample: sampleView(loaded, now()) };
  }

  // Issues: deleted as the person; if Jira refuses (no Delete issues permission), kept with a comment and moved to a
  // done status where the workflow has one. The result says which: deleted, not found, closed, commented, failed.
  // Pages: the app has no right to delete pages, so the person deletes the parent page with its children; the record
  // is cleared either way.
  async function remove({ spaceId }) {
    if (!/^\d{1,20}$/.test(String(spaceId ?? ''))) return { error: 'Open the Cold Read page of a space.' };
    const record = await deps.getRecord(spaceId);
    if (!record) return { removed: { deleted: [], missing: [], closed: [], commented: [], failed: [] }, pagesLeft: null };
    if (sampleState(record, now()) === 'loading') return { error: 'The sample is loading. Refresh this page in a minute.' };

    const started = now();
    const removed = { deleted: [], missing: [], closed: [], commented: [], failed: [] };
    for (const key of Object.values(record.issues ?? {})) {
      const res = await deps.deleteIssue(key);
      if (res.ok) {
        removed.deleted.push(key);
        continue;
      }
      if (res.status === 404) {
        removed.missing.push(key); // already deleted, or the person cannot see it
        continue;
      }
      if (res.status === 403 || res.status === 401) {
        const closed = await deps.closeIssue(key, adfParagraph(REMOVED_COMMENT));
        if (closed.error) removed.failed.push(key);
        else if (closed.closed) removed.closed.push(key);
        else removed.commented.push(key);
        continue;
      }
      removed.failed.push(key);
    }
    await deps.deleteRecord(spaceId);
    const pagesLeft = record.parent ? { ...record.parent, count: (record.pages?.length ?? 0) + 1 } : null;
    log(`sample remove space=${spaceId} ms=${now() - started} deleted=${removed.deleted.join(',')} missing=${removed.missing.join(',')} closed=${removed.closed.join(',')} commented=${removed.commented.join(',')} failed=${removed.failed.join(',')} pages_left=${pagesLeft ? pagesLeft.count : 0}`);
    return { removed, pagesLeft };
  }

  return { load, remove };
}
