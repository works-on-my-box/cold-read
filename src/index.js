// The two Rovo actions of the Cold Reader agent.
// Order the backend holds: the reader first takes the packet (page text and questions,
// never the expected answers), then submits its answers once per run.
import { fetchPage } from './confluence';
import { getQuestions, startRun, getRun, recordAnswers } from './store';
import { NOT_STATED, parseAnswers, submitRefusal, isPageId, isRunId } from './logic';

// The page the agent named, or, if that is not a page ID, the page the chat was opened on.
// Rovo passes action inputs as top-level payload fields and the product context in payload.context.
function pickPageId(payload) {
  const fromInput = String(payload?.pageId ?? '').trim();
  if (isPageId(fromInput)) return fromInput;
  const fromContext = String(payload?.context?.confluence?.contentId ?? '').trim();
  return isPageId(fromContext) ? fromContext : null;
}

export async function getPacket(payload, context) {
  const pageId = pickPageId(payload);
  if (!pageId) return { error: 'Give the numeric ID of the Confluence page to read.' };

  const page = await fetchPage(pageId, { withBody: true });
  if (page.error) return { error: page.error };

  const { questions } = await getQuestions(pageId);
  const run = await startRun({
    pageId,
    title: page.title,
    pageVersion: page.version,
    questions,
    accountId: context?.principal?.accountId,
  });
  console.log(`packet page=${pageId} run=${run.runId} v=${page.version} chars=${page.text.length} questions=${questions.length}`);

  return {
    pageId,
    runId: run.runId,
    title: page.title,
    pageText: page.text,
    questions: questions.map((q, i) => ({ q: i + 1, question: q.text })),
    rule: `Answer only from pageText. If pageText does not state the answer, the answer starts with ${NOT_STATED}.`,
  };
}

export async function submitAnswers(payload, context) {
  const pageId = pickPageId(payload);
  const runId = String(payload?.runId ?? '').trim();
  if (!pageId || !isRunId(runId)) {
    return { error: 'Pass the pageId and runId from the packet of get-cold-read-packet.' };
  }

  // KVS is written as the app, so the run itself decides whether this person may answer now.
  const run = await getRun(pageId, runId);
  const refusal = submitRefusal(run, { pageId, runId, accountId: context?.principal?.accountId });
  if (refusal) {
    console.log(`answers refused page=${pageId} run=${runId}: ${refusal}`);
    return { error: refusal };
  }

  const parsed = parseAnswers(payload?.answers, run.questions.length);
  if (parsed.error) {
    console.log(`answers unreadable page=${pageId} run=${runId}: ${parsed.error}`);
    return { error: parsed.error };
  }

  const saved = await recordAnswers(run, parsed);
  const notStated = saved.answers.filter((a) => a.notStated).length;
  console.log(`answers page=${pageId} run=${runId} answered=${saved.answers.length} notStated=${notStated} missing=${saved.missing.length}`);

  return {
    status: 'saved',
    pageId,
    runId,
    answered: saved.answers.length,
    notStated,
    missing: saved.missing,
    next: 'Tell the user the answers are saved and that Cold Read under the page title shows them next to the expected answers.',
  };
}
