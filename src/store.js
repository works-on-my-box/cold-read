// Cold Read data in Forge Key-Value Store (scope storage:app).
// KVS is per installation and is read and written as the app, so the callers
// check what the user may do before they call these functions.
//
// Keys (KVS allows letters, digits and : . _ - # and spaces, up to 500 characters):
//   questions:<pageId>        questions of a page and the owner's expected answers
//   run:<pageId>:<runId>      one cold read: the questions given to the reader, its answers
//   lastrun:<pageId>          runId of the latest finished cold read of the page
//   jiraproject:<spaceId>     Jira project last used for Cold Read issues in the space
import { kvs, WhereConditions } from '@forge/kvs';
import { HANDOFF_QUESTIONS, newRunId, replacesLastRun } from './logic';

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

export async function saveQuestions(pageId, questions, accountId) {
  await kvs.set(questionsKey(pageId), {
    questions,
    updatedAt: new Date().toISOString(),
    updatedBy: accountId,
  });
}

// Back to the default handoff set.
export async function resetQuestions(pageId) {
  await kvs.delete(questionsKey(pageId));
}

// A run starts when the reader takes the packet. Only question texts are copied into it:
// the expected answers stay with the page questions and never reach the reader.
export async function startRun({ pageId, title, pageVersion, questions, accountId }) {
  const run = {
    runId: newRunId(),
    pageId,
    title,
    pageVersion,
    status: 'reading',
    startedAt: new Date().toISOString(),
    startedBy: accountId,
    questions: questions.map(({ id, text }) => ({ id, text })),
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

// The warm read of a run: which related pages the reader got, and with what search.
export async function recordWarm(run, { terms, sources }) {
  const warm = { ...run, warm: { at: new Date().toISOString(), terms, sources } };
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
