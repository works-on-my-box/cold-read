// Backend of the Cold Read panel (the "Cold Read" item under the page title).
// The page ID always comes from the Forge context of the panel, never from the browser payload.
import Resolver from '@forge/resolver';
import { getAppContext } from '@forge/api';
import { fetchPage, canEditPage, createPage, pageByTitle } from './confluence';
import { creatableProjects, createIssue, addComment, deleteIssue, closeIssue } from './jira';
import { getQuestions, saveQuestions, resetQuestions, getLastRun, recordJira, getSpaceJiraProject, setSpaceJiraProject, pagesWithColdRead } from './store';
import { getSampleRecord, setSampleRecord, deleteSampleRecord } from './store';
import { sampleView, withSamplePages } from './sample';
import { makeSample } from './sample-run';
import { startRun, getRun, recordAnswers, recordWarm, recordFindings, recordFailure, markPending, getPendingRun, claimStep, spend } from './store';
import { validateQuestions, pageState, findingsIssue, STATE_ORDER, inSpaceSummary, isRunId, interruptedRun, logsElements, siteOf, RUNS_LEFT_SHOWN_BELOW } from './logic';
import { findRelated, forViewer } from './related';
import { pickModel, callModel } from './llm';
import { makeAutoRun } from './autorun';
import { checkOneClickFlag } from './guard';
import * as guardConfig from './guard-config';

const resolver = new Resolver();
const autoRun = makeAutoRun({
  fetchPage,
  findRelated,
  getQuestions,
  startRun,
  getRun,
  recordAnswers,
  recordWarm,
  recordFindings,
  recordFailure,
  markPending,
  claimStep,
  reserveSpend: spend.reserve,
  settleSpend: spend.settle,
  pickModel,
  callModel,
  guardConfig,
  checkFlag: checkOneClickFlag,
  // A logging switch must not break a run: without the app context the elements are not logged.
  elementsLogged: () => {
    try {
      return logsElements(getAppContext().environmentType);
    } catch {
      return false;
    }
  },
});

// "Load sample handoffs" and "Remove sample" on the space page: pages and issues are made and removed as the user.
const sample = makeSample({
  createIssue,
  addComment,
  deleteIssue,
  closeIssue,
  pageByTitle,
  createPage,
  getRecord: getSampleRecord,
  setRecord: setSampleRecord,
  deleteRecord: deleteSampleRecord,
  setSpaceJiraProject,
  log: (line) => console.log(line),
});

const spaceOf = (context) => String(context?.extension?.space?.id ?? '');

function pageOf(context) {
  const content = context?.extension?.content;
  return { pageId: String(content?.id ?? ''), type: content?.type };
}

// The site of the call from the platform's data (installContext comes from the runtime, not from the panel).
function siteOfContext(context) {
  return {
    cloudId: siteOf(context?.installContext),
    installContext: context?.installContext,
    environmentId: context?.environmentId,
    environmentType: context?.environmentType,
  };
}

// Usual one-click runs left on the site, only when they are few (the panel shows one quiet line); null otherwise
// or if the counters cannot be read. The first call of an installation without the install event records the moment.
async function fewRunsLeft() {
  try {
    const n = await spend.left();
    return n < RUNS_LEFT_SHOWN_BELOW ? n : null;
  } catch (err) {
    console.log(`spend left failed: ${err?.code ?? err?.name ?? 'error'}`);
    return null;
  }
}

resolver.define('getState', async ({ context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { unsupported: true };

  // asUser: fails with 403/404 if the person cannot see the page.
  const page = await fetchPage(pageId);
  if (page.error) return { error: page.error };

  const [{ questions, isDefault }, lastRun, canEdit, pending, runsLeft] = await Promise.all([
    getQuestions(pageId),
    getLastRun(pageId),
    canEditPage(pageId),
    getPendingRun(pageId),
    fewRunsLeft(),
  ]);
  // interrupted: a one-click run whose answers are saved but whose second step never ran. lastRun: as this person may
  // see it (forViewer).
  const shown = lastRun ? await forViewer(lastRun) : null;
  return { pageId, title: page.title, pageVersion: page.version, canEdit, questions, isDefault, lastRun: shown, interrupted: interruptedRun(pending, lastRun), runsLeft };
});

resolver.define('saveQuestions', async ({ payload, context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { error: 'Cold Read works on pages only.' };
  if (!(await canEditPage(pageId))) return { error: 'Only people who can edit this page can change its questions.' };

  const checked = validateQuestions(payload?.questions);
  if (checked.error) return { error: checked.error };
  await saveQuestions(pageId, checked.questions);
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
  if (projects.error) return projects;
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

  // The issue holds what this person may see of the run; the record keeps the run as it is.
  const fields = findingsIssue(await forViewer(run), { pageTitle: page.title, pageUrl: page.url });
  if (fields.error) return { error: fields.error };
  const created = await createIssue({ projectId, summary: fields.summary, description: fields.description, assigneeId: page.ownerId });
  if (created.error) return { error: created.error };

  const jira = {
    key: created.key,
    url: page.url ? `${new URL(page.url).origin}/browse/${created.key}` : null,
    assigned: created.assigned,
    findings: fields.count,
    createdAt: new Date().toISOString(),
  };
  await recordJira(run, jira);
  if (page.spaceId) await setSpaceJiraProject(page.spaceId, projectId);
  console.log(`jira page=${pageId} run=${run.runId} issue=${created.key} assigned=${created.assigned} A=${fields.count}`);
  return { jira };
});

// The one-click run, step 1: the cold read of the page by a fresh model call. The panel calls autoRunCompare next
// with the runId it returns. Anyone who can see the page may run it; the site has a spend limit (src/spend.js), and
// the run can be switched off for a site or for all (src/guard.js, src/guard-config.js).
resolver.define('autoRunCold', async ({ context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { error: 'Cold Read works on pages only.' };
  return autoRun.cold(pageId, siteOfContext(context));
});

// The one-click run, step 2: compare with the expected answers, or the warm read without them; saves the findings.
resolver.define('autoRunCompare', async ({ payload, context }) => {
  const { pageId, type } = pageOf(context);
  if (type !== 'page') return { error: 'Cold Read works on pages only.' };
  const runId = String(payload?.runId ?? '');
  if (!isRunId(runId)) return { error: 'There is no cold read to compare. Run a new one.' };
  return autoRun.compare(pageId, runId, siteOfContext(context));
});

// Space summary: pages of this space with Cold Read questions or runs and the handoffs of the sample, worst first,
// and the state of the sample. Pages are read as the user, so pages they cannot see are left out.
resolver.define('getSpaceSummary', async ({ context }) => {
  const spaceId = spaceOf(context);
  const record = spaceId ? await getSampleRecord(spaceId) : undefined;
  const ids = withSamplePages(await pagesWithColdRead(), record);
  const rows = await Promise.all(
    ids.map(async (pageId) => {
      const page = await fetchPage(pageId);
      if (!inSpaceSummary(page, spaceId)) return null;
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
  return { pages, sample: sampleView(record) };
});

// The sample of the space: five pages and two Jira issues in the project the person picks, all made as them.
resolver.define('loadSample', async ({ payload, context }) => sample.load({ spaceId: spaceOf(context), projectId: payload?.projectId }));

resolver.define('removeSample', async ({ context }) => sample.remove({ spaceId: spaceOf(context) }));

export const handler = resolver.getDefinitions();
