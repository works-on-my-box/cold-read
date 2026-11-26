// Cold Read data in Forge Key-Value Store (scope storage:app).
// KVS is per installation and is read and written as the app, so the callers
// check what the user may do before they call these functions.
// No record holds an Atlassian account ID.
//
// Keys (KVS allows letters, digits and : . _ - # and spaces, up to 500 characters):
//   questions:<pageId>        questions of a page and the owner's expected answers
//   run:<pageId>:<runId>      one cold read: the questions given to the reader, its answers
//   lastrun:<pageId>          runId of the latest finished cold read of the page
//   jiraproject:<spaceId>     Jira project last used for Cold Read issues in the space
//   pending:<pageId>          runId of the latest one-click run of the page whose answers are saved ("Continue")
//   step:<pageId>:<runId>:<step> a step of a one-click run that was started: each step is taken once
//   sample:<spaceId>          what "Load sample handoffs" created in the space: issue keys, page ids, titles, links
//   spend:*                   the spend limit of the one-click run (src/spend.js); the budget:<YYYY-MM-DD> run
//                             counts of earlier versions are no longer read
import { kvs, WhereConditions } from '@forge/kvs';
import { HANDOFF_QUESTIONS, newRunId, replacesLastRun } from './logic';
import { makeSpend } from './spend';

// The spend counters of the one-click run in this installation's store.
export const spend = makeSpend(kvs);

const questionsKey = (pageId) => `questions:${pageId}`;
const runKey = (pageId, runId) => `run:${pageId}:${runId}`;
const lastRunKey = (pageId) => `lastrun:${pageId}`;

// Saved questions of the page, or the default handoff set if the owner has not saved any.
export async function getQuestions(pageId) {
  const saved = await kvs.get(questionsKey(pageId));
  if (saved?.questions?.length) {
    return { questions: saved.questions, isDefault: false, updatedAt: saved.updatedAt };
  }
  return { questions: HANDOFF_QUESTIONS, isDefault: true };
}

export async function saveQuestions(pageId, questions) {
  await kvs.set(questionsKey(pageId), {
    questions,
    updatedAt: new Date().toISOString(),
  });
}

// Back to the default handoff set.
export async function resetQuestions(pageId) {
  await kvs.delete(questionsKey(pageId));
}

// A run starts when the reader takes the packet. Only question texts are copied into it:
// the expected answers stay with the page questions and never reach the reader.
// A one-click run is marked via: 'button', clipped: true if the model got only the start of the page, and spend:
// { day, reserved } - the UTC day its reserve was counted on and what is still reserved for its second step.
export async function startRun({ pageId, title, pageVersion, questions, via, clipped, spend: reserve }) {
  const run = {
    runId: newRunId(),
    pageId,
    title,
    pageVersion,
    status: 'reading',
    startedAt: new Date().toISOString(),
    questions: questions.map(({ id, text }) => ({ id, text })),
    ...(via ? { via } : {}),
    ...(clipped ? { clipped: true } : {}),
    ...(reserve ? { spend: reserve } : {}),
  };
  // lastrun moves only when a run is finished (recordFindings).
  await kvs.set(runKey(pageId, run.runId), run);
  return run;
}

export async function getRun(pageId, runId) {
  return kvs.get(runKey(pageId, runId));
}

export async function getLastRun(pageId) {
  const runId = await kvs.get(lastRunKey(pageId));
  return runId ? kvs.get(runKey(pageId, runId)) : undefined;
}

// answers: [{ q, answer, quote, notStated }] where q is the 1-based number in run.questions.
// The expected answers of the page are copied into the run now, after the answers are fixed:
// later edits of the questions do not change what this run was checked against.
export async function recordAnswers(run, { answers, missing }, pageQuestions) {
  const expectedById = new Map(pageQuestions.map((q) => [q.id, q.expected]));
  const answered = {
    ...run,
    status: 'answered',
    answeredAt: new Date().toISOString(),
    questions: run.questions.map((q) => ({ ...q, expected: expectedById.get(q.id) || '' })),
    answers: answers.map((a) => ({ ...a, questionId: run.questions[a.q - 1].id })),
    missing,
  };
  await kvs.set(runKey(run.pageId, run.runId), answered);
  return answered;
}

// findings: [{ q, verdict: 'match' | 'A' | 'B' | 'C', note }].
export async function recordFindings(run, findings) {
  const checked = {
    ...run,
    status: 'checked',
    checkedAt: new Date().toISOString(),
    findings: findings.map((f) => ({ ...f, questionId: run.questions[f.q - 1].id })),
  };
  // One transaction, so lastrun never points to a run that was not saved.
  let tx = kvs.transact().set(runKey(run.pageId, run.runId), checked);
  if (replacesLastRun(await getLastRun(run.pageId), checked)) tx = tx.set(lastRunKey(run.pageId), run.runId);
  await tx.execute();
  return checked;
}

// A one-click run whose model call failed twice or whose search failed. lastrun does not move (only recordFindings
// moves it), so the last finished run of the page stays in view.
export async function recordFailure(run, error) {
  const failed = { ...run, status: 'failed', failedAt: new Date().toISOString(), error: String(error).slice(0, 300) };
  await kvs.set(runKey(run.pageId, run.runId), failed);
  return failed;
}

// The latest one-click run of the page whose answers are saved: if its second step never ran (the panel was
// closed), the panel offers to continue it. The key is not cleared: the run's own status says whether it finished.
export async function markPending(run) {
  await kvs.set(`pending:${run.pageId}`, run.runId);
}

export async function getPendingRun(pageId) {
  const runId = await kvs.get(`pending:${pageId}`);
  return runId ? kvs.get(runKey(pageId, runId)) : undefined;
}

// Takes a step of a one-click run: true for the first call of that step, false for any later one (the key exists) or
// if the store refuses. The mark is never cleared, so a step that broke off is not taken again.
export async function claimStep(pageId, runId, step) {
  try {
    await kvs.set(`step:${pageId}:${runId}:${step}`, { at: new Date().toISOString() }, { keyPolicy: 'FAIL_IF_EXISTS' });
    return true;
  } catch {
    return false;
  }
}

// The warm read of a run: { links, sources, answers? } - how many Jira issues and pages the page names, the linked
// sources the reader got (each marked used in a one-click run), and the answers of the one-click run's step 2.
export async function recordWarm(run, warmRead) {
  const warm = { ...run, warm: { at: new Date().toISOString(), ...warmRead } };
  await kvs.set(runKey(run.pageId, run.runId), warm);
  return warm;
}

// The Jira issue made for the A findings of a run: one per run.
export async function recordJira(run, jira) {
  const withJira = { ...run, jira };
  await kvs.set(runKey(run.pageId, run.runId), withJira);
  return withJira;
}

// The Jira project last used for Cold Read issues in a space, so the panel offers it first.
export async function getSpaceJiraProject(spaceId) {
  return kvs.get(`jiraproject:${spaceId}`);
}

export async function setSpaceJiraProject(spaceId, projectId) {
  await kvs.set(`jiraproject:${spaceId}`, projectId);
}

// IDs of pages that have saved questions or a cold read, across the installation (KVS has no
// per-space index). The query is eventually consistent, which is fine for a summary.
export async function pagesWithColdRead(max = 100) {
  const ids = new Set();
  for (const prefix of ['lastrun:', 'questions:']) {
    let cursor;
    do {
      let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(50);
      if (cursor) query = query.cursor(cursor);
      const { results, nextCursor } = await query.getMany();
      results.forEach((r) => ids.add(r.key.slice(prefix.length)));
      cursor = nextCursor;
    } while (cursor && ids.size < max);
  }
  return [...ids].slice(0, max);
}

// The sample of a space (src/sample-run.js): keys of its issues and ids of its pages, no people.
export async function getSampleRecord(spaceId) {
  return kvs.get(`sample:${spaceId}`);
}

export async function setSampleRecord(spaceId, record) {
  await kvs.set(`sample:${spaceId}`, record);
}

export async function deleteSampleRecord(spaceId) {
  await kvs.delete(`sample:${spaceId}`);
}
