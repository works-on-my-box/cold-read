// The Rovo actions of the Cold Reader agent. Order the backend holds for one run:
// 1. get-cold-read-packet: page text and questions, never the expected answers;
// 2. submit-cold-read-answers: answers are saved once, and only then the expected answers come back;
// 3. submit-cold-read-findings: the reader's own verdicts against the expected answers, once.
import { fetchPage } from './confluence';
import { getQuestions, startRun, getRun, recordAnswers, recordFindings } from './store';
import { NOT_STATED, parseAnswers, parseFindings, runRefusal, expectedOf, isPageId, isRunId } from './logic';

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

// pageId and runId of a run the agent names, or { error }.
function runIds(payload) {
  const pageId = pickPageId(payload);
  const runId = String(payload?.runId ?? '').trim();
  if (!pageId || !isRunId(runId)) {
    return { error: 'Pass the pageId and runId from the packet of get-cold-read-packet.' };
  }
  return { pageId, runId };
}

// KVS is written as the app, so the run itself decides whether this person may take this step now.
async function runFor(step, payload, context) {
  const ids = runIds(payload);
  if (ids.error) return ids;
  const run = await getRun(ids.pageId, ids.runId);
  const refusal = runRefusal(run, step, { ...ids, accountId: context?.principal?.accountId });
  if (refusal) {
    console.log(`${step} refused page=${ids.pageId} run=${ids.runId}: ${refusal}`);
    return { error: refusal };
  }
  return { ...ids, run };
}

export async function submitAnswers(payload, context) {
  const { pageId, runId, run, error } = await runFor('answers', payload, context);
  if (error) return { error };

  const parsed = parseAnswers(payload?.answers, run.questions.length);
  if (parsed.error) {
    console.log(`answers unreadable page=${pageId} run=${runId}: ${parsed.error}`);
    return { error: parsed.error };
  }

  const { questions: pageQuestions } = await getQuestions(pageId);
  const saved = await recordAnswers(run, parsed, pageQuestions);
  const notStated = saved.answers.filter((a) => a.notStated).length;
  const expected = expectedOf(saved);
  console.log(`answers page=${pageId} run=${runId} answered=${saved.answers.length} notStated=${notStated} missing=${saved.missing.length} expected=${expected.length}`);

  if (expected.length === 0) {
    return {
      status: 'saved',
      pageId,
      runId,
      answered: saved.answers.length,
      notStated,
      missing: saved.missing,
      next: 'The page owner set no expected answers, so there is nothing to compare. Tell the user the answers are saved, list the NOT STATED ones as gaps in the page, and say that Cold Read under the page title shows the answers.',
    };
  }
  // The answers are fixed now, so the expected answers can be shown to the reader.
  return {
    status: 'saved',
    pageId,
    runId,
    answered: saved.answers.length,
    notStated,
    missing: saved.missing,
    expected,
    next: 'Compare each of your saved answers with the expected answer and call submit-cold-read-findings once.',
  };
}

export async function submitFindings(payload, context) {
  const { pageId, runId, run, error } = await runFor('findings', payload, context);
  if (error) return { error };

  const allowed = new Set(expectedOf(run).map((item) => item.q));
  if (allowed.size === 0) return { error: 'This cold read has no expected answers to compare with.' };
  const parsed = parseFindings(payload?.findings, allowed);
  if (parsed.error) {
    console.log(`findings unreadable page=${pageId} run=${runId}: ${parsed.error}`);
    return { error: parsed.error };
  }

  const saved = await recordFindings(run, parsed.findings);
  const count = (v) => saved.findings.filter((f) => f.verdict === v).length;
  console.log(`findings page=${pageId} run=${runId} A=${count('A')} B=${count('B')} C=${count('C')} match=${count('match')}`);
  return {
    status: 'saved',
    pageId,
    runId,
    findings: { A: count('A'), B: count('B'), C: count('C'), match: count('match') },
    next: 'Show the user the findings, A first, each with its note, and say that Cold Read under the page title shows them.',
  };
}
