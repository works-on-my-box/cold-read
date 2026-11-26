// The sources of the warm read, for the agent action get-warm-read-packet and the one-click run: only the Jira issues
// and Confluence pages the page names itself (pageLinks of its storage format). There is no search by the words of the
// title (21.11.2026: it brought in pages about other clients and a stale handoff, and the warm read took them for the truth).
// No Forge imports here: src/related.js passes in the Confluence and Jira calls (as the user), the tests pass fakes.
// (The .js extension lets plain Node load this file in the tests.)
import { pickSources, runForViewer, clipSource } from './logic.js';

const RELATED_PAGES = 5;
const RELATED_ISSUES = 5;
const RELATED_CHARS = 4000;

export function makeFindRelated({ fetchPage, fetchIssue, pageByTitle }) {
  // page: { pageId, spaceId, links } - the space and the links of the page as read now.
  // Returns { related, relatedIssues, sources }: the linked pages and issues the person can read. The page itself, pages
  // and issues that cannot be read (no such issue, no access) and Cold Read's own issues (label cold-read: they repeat
  // an earlier run's findings) are left out.
  // limits (the one-click run): at most `sources` pages and issues in all, taken in turn, each cut to `chars` characters.
  return async function findRelated({ pageId, spaceId, links }, limits) {
    let pages = [];
    let issues = [];
    if (links) {
      const byTitle = await Promise.all(links.pageTitles.map((t) => pageByTitle(t.title, { spaceKey: t.spaceKey, spaceId })));
      const ids = [...new Set([...links.pageIds, ...byTitle.flatMap((found) => (found.error ? [] : found.map((p) => p.id)))])]
        .filter((id) => id !== String(pageId));
      const [read, got] = await Promise.all([
        Promise.all(ids.map((id) => fetchPage(id, { withBody: true }))),
        Promise.all(links.issueKeys.map((key) => fetchIssue(key))),
      ]);
      pages = read.filter((p) => !p.error);
      issues = got.filter((i) => !i.error && !(i.labels ?? []).includes('cold-read'));
    }
    const chars = limits?.chars ?? RELATED_CHARS;
    const picked = limits ? pickSources(pages, issues, limits.sources) : { pages: pages.slice(0, RELATED_PAGES), issues: issues.slice(0, RELATED_ISSUES) };
    // The one-click run: each source also within its part of the reserve (clipSource), text in other scripts shorter.
    const fit = (source) => (limits ? clipSource(source) : source);
    const related = picked.pages.map((p) => fit({ pageId: p.id, title: p.title, text: p.text.slice(0, chars) }));
    const relatedIssues = picked.issues.map((i) => fit({ issueKey: i.key, title: i.summary, status: i.status, text: i.text.slice(0, chars) }));
    const sources = [
      ...related.map(({ pageId: id, title }) => ({ pageId: id, title })),
      ...relatedIssues.map(({ issueKey, title }) => ({ issueKey, title })),
    ];
    return { related, relatedIssues, sources };
  };
}

// What a run shows to the person who asks (runForViewer): each linked source of its warm read is checked at once as
// that person - an issue by its summary, a page without its body - and those they cannot open are left out.
export function makeForViewer({ fetchPage, canSeeIssue }) {
  return async function forViewer(run) {
    const sources = run?.warm?.sources ?? [];
    const open = await Promise.all(sources.map((s) => (s.issueKey ? canSeeIssue(s.issueKey) : fetchPage(s.pageId).then((p) => !p.error))));
    return runForViewer(run, sources.filter((_, i) => !open[i]));
  };
}
