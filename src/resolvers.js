// Backend of the Cold Read panel (the "Cold Read" item under the page title).
// The page ID always comes from the Forge context of the panel, never from the browser payload.
import Resolver from '@forge/resolver';
import { fetchPage, canEditPage } from './confluence';
import { creatableProjects, createIssue } from './jira';
import { getQuestions, saveQuestions, resetQuestions, getLastRun, recordJira, getSpaceJiraProject, setSpaceJiraProject, pagesWithColdRead } from './store';
import { validateQuestions, pageState, findingsIssue, STATE_ORDER } from './logic';

const resolver = new Resolver();

function pageOf(context) {
  const content = context?.extension?.content;
  return { pageId: String(content?.id ?? ''), type: content?.type };
}

resolver.define('getState', async ({ context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { unsupported: true };

  // asUser: fails with 403/404 if the person cannot see the page.
  const page = await fetchPage(pageId);
  if (page.error) return { error: page.error };

  const [{ questions, isDefault }, lastRun, canEdit] = await Promise.all([
    getQuestions(pageId),
    getLastRun(pageId),
    canEditPage(pageId),
  ]);
  return { pageId, title: page.title, pageVersion: page.version, canEdit, questions, isDefault, lastRun: lastRun ?? null };
});

resolver.define('saveQuestions', async ({ payload, context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { error: 'Cold Read works on pages only.' };
  if (!(await canEditPage(pageId))) return { error: 'Only people who can edit this page can change its questions.' };

  const checked = validateQuestions(payload?.questions);
  if (checked.error) return { error: checked.error };
  await saveQuestions(pageId, checked.questions, context?.accountId);
  return { questions: checked.questions, isDefault: false };
});

resolver.define('resetQuestions', async ({ context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { error: 'Cold Read works on pages only.' };
  if (!(await canEditPage(pageId))) return { error: 'Only people who can edit this page can change its questions.' };

  await resetQuestions(pageId);
  return getQuestions(pageId);
});

// Jira projects for the issue about A findings, the one last used in this space first.
resolver.define('getJiraProjects', async ({ context }) => {
  const projects = await creatableProjects();
  if (projects.error) return { error: projects.error };
  const spaceId = String(context?.extension?.space?.id ?? '');
  const last = spaceId ? await getSpaceJiraProject(spaceId) : undefined;
  return { projects, defaultProjectId: projects.some((p) => p.id === last) ? last : projects[0]?.id ?? null };
});

// One Jira issue per run for its A findings, assigned to the page owner. Anyone who can see the page
// may file it; Jira checks that they can create issues in the project.
resolver.define('createJiraIssue', async ({ payload, context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { error: 'Cold Read works on pages only.' };
  const projectId = String(payload?.projectId ?? '');
  if (!/^\d{1,20}$/.test(projectId)) return { error: 'Choose a Jira project.' };

  const page = await fetchPage(pageId);
  if (page.error) return { error: page.error };
  const run = await getLastRun(pageId);
  if (!run) return { error: 'This page has no cold read yet.' };
  if (run.runId !== payload?.runId) return { error: 'This page has a newer cold read. Press Refresh.' };
  if (run.jira) return { jira: run.jira };

  const fields = findingsIssue(run, { pageTitle: page.title, pageUrl: page.url });
  if (fields.error) return { error: fields.error };
  const created = await createIssue({ projectId, summary: fields.summary, description: fields.description, assigneeId: page.ownerId });
  if (created.error) return { error: created.error };

  const jira = {
    key: created.key,
    url: page.url ? `${new URL(page.url).origin}/browse/${created.key}` : null,
    assigned: created.assigned,
    findings: fields.count,
    createdAt: new Date().toISOString(),
    createdBy: context?.accountId,
  };
  await recordJira(run, jira);
  if (page.spaceId) await setSpaceJiraProject(page.spaceId, projectId);
  console.log(`jira page=${pageId} run=${run.runId} issue=${created.key} assigned=${created.assigned} A=${fields.count}`);
  return { jira };
});

// Space summary: pages of this space with Cold Read questions or runs, worst first.
// Pages are read as the user, so pages they cannot see are left out.
resolver.define('getSpaceSummary', async ({ context }) => {
  const spaceId = String(context?.extension?.space?.id ?? '');
  const ids = await pagesWithColdRead();
  const rows = await Promise.all(
    ids.map(async (pageId) => {
      const page = await fetchPage(pageId);
      if (page.error || page.spaceId !== spaceId) return null;
      const [{ questions, isDefault }, run] = await Promise.all([getQuestions(pageId), getLastRun(pageId)]);
      return {
        pageId,
        title: page.title,
        url: page.webui ? `/wiki${page.webui}` : null,
        questions: questions.length,
        withExpected: questions.filter((q) => q.expected).length,
        isDefault,
        state: pageState(run, page.version),
        checkedAt: run?.checkedAt || run?.answeredAt || run?.startedAt || null,
        jira: run?.jira ? { key: run.jira.key, url: run.jira.url } : null,
      };
    }),
  );
  const pages = rows.filter(Boolean).sort((x, y) => STATE_ORDER.indexOf(x.state.key) - STATE_ORDER.indexOf(y.state.key));
  return { pages };
});

export const handler = resolver.getDefinitions();
