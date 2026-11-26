// The warm read in the panel: the names of the linked sources, the line under the result and the finding of a row.
export const sourceName = (s) => (s.issueKey ? s.issueKey : `“${s.title}”`);

// The hint for a page that links to nothing: without expected answers it is the only way to a comparison.
export const NO_LINKS =
  'This page links to no Jira issues or pages. Link the ones it depends on, and Cold Read will compare the answers with them.';

// The line under the result of a warm read: the sources the answers were compared with - in a one-click run only those
// an answer rests on (marked used); a run of the agent or of an earlier version has no marks, and all its sources are
// named - or why nothing was compared.
export function warmLine(warm) {
  if (warm.hidden) return 'This cold read was compared with a linked Jira issue or page that Cold Read cannot open for you, so the answers given with the linked sources, the notes and the quotes are not shown. If you can open them, press Refresh.';
  const sources = warm.sources ?? [];
  if (!sources.length) {
    return warm.links
      ? 'Cold Read could not open the Jira issues and pages this page links to, so the answers are not compared with them.'
      : NO_LINKS;
  }
  const used = sources.filter((s) => s.used !== false);
  if (!used.length) return 'None of the Jira issues and pages this page links to is about the same work: the answers come from the page alone.';
  return `Compared with: ${used.map((s) => (s.issueKey ? `${s.issueKey} “${s.title}”` : `“${s.title}”`)).join(', ')}.`;
}

// The finding in the row of question q (1-based) and its part for that question: a finding of a warm read is one per
// linked source, names the questions it touches and keeps for each of them its own two quotes and sentence; a finding
// of a compare with expected answers belongs to one question and is its own part.
export function findingRow(findings, q, questionId) {
  const finding = findings.find((f) => (f.questions ? f.questions.includes(q) : f.questionId === questionId));
  return finding ? { finding, part: finding.parts?.find((p) => p.q === q) ?? finding } : null;
}
