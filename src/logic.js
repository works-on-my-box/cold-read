// Pure logic of Cold Read. No Forge imports here, so `npm test` can check it with plain Node.

export const NOT_STATED = 'NOT STATED';
export const MAX_QUESTIONS = 10;
export const MAX_QUESTION_CHARS = 300;
export const MAX_EXPECTED_CHARS = 1000;
const MAX_ANSWER_CHARS = 2000;

// The default question set: what the next person must get right when work is handed over.
// A page without saved questions is read with these.
export const HANDOFF_QUESTIONS = [
  { id: 'h1', text: 'Where does the work stand right now?', expected: '' },
  { id: 'h2', text: 'What is the single next step, and who does it?', expected: '' },
  { id: 'h3', text: 'What has been decided?', expected: '' },
  { id: 'h4', text: 'What has already been done that must not be done again?', expected: '' },
  { id: 'h5', text: 'Who is waiting on whom, and for what?', expected: '' },
];

// Confluence storage format (XHTML) to plain text: block tags become line breaks, the rest is dropped.
export function storageToText(xhtml) {
  return String(xhtml || '')
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Checks the question list the page owner saves from the panel.
// Returns { questions } with trimmed values, or { error } with a message for the user.
export function validateQuestions(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: 'Add at least one question.' };
  }
  if (input.length > MAX_QUESTIONS) {
    return { error: `A page can have at most ${MAX_QUESTIONS} questions.` };
  }
  const seen = new Set();
  const questions = [];
  for (const [i, item] of input.entries()) {
    const id = String(item?.id ?? '');
    const text = String(item?.text ?? '').trim();
    const expected = String(item?.expected ?? '').trim();
    if (!/^[a-z0-9-]{1,24}$/.test(id) || seen.has(id)) {
      return { error: `Question ${i + 1} has a bad id. Reload the panel and try again.` };
    }
    if (!text) return { error: `Question ${i + 1} is empty.` };
    if (text.length > MAX_QUESTION_CHARS) {
      return { error: `Question ${i + 1} is longer than ${MAX_QUESTION_CHARS} characters.` };
    }
    if (expected.length > MAX_EXPECTED_CHARS) {
      return { error: `The expected answer to question ${i + 1} is longer than ${MAX_EXPECTED_CHARS} characters.` };
    }
    seen.add(id);
    questions.push({ id, text, expected });
  }
  return { questions };
}

// Parses the answers the agent sends to submit-cold-read-answers.
// The agent is asked for a JSON array of {"q": number, "answer": string, "quote": string},
// but a language model may wrap it in a code fence or in an object, so both are accepted.
// Returns { answers, missing } (missing = question numbers without an answer), or { error }.
export function parseAnswers(raw, questionCount) {
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      data = JSON.parse(text);
    } catch {
      data = parseAnswerLines(text);
      if (!data) {
        return { error: 'answers must be a JSON array of {"q": number, "answer": string, "quote": string}.' };
      }
    }
  }
  if (data && !Array.isArray(data) && Array.isArray(data.answers)) data = data.answers;
  if (!Array.isArray(data)) {
    return { error: 'answers must be a JSON array of {"q": number, "answer": string, "quote": string}.' };
  }
  const byNumber = new Map();
  for (const item of data) {
    const q = Number(item?.q);
    if (!Number.isInteger(q) || q < 1 || q > questionCount || byNumber.has(q)) continue;
    const answer = String(item?.answer ?? '').trim().slice(0, MAX_ANSWER_CHARS);
    if (!answer) continue;
    const quote = String(item?.quote ?? '').trim().slice(0, MAX_ANSWER_CHARS);
    const notStated = answer.toUpperCase().startsWith(NOT_STATED);
    byNumber.set(q, { q, answer, quote, notStated });
  }
  if (byNumber.size === 0) return { error: 'No valid answers found. Answer each question by its number q.' };
  const answers = [...byNumber.values()].sort((a, b) => a.q - b.q);
  const missing = [];
  for (let q = 1; q <= questionCount; q += 1) if (!byNumber.has(q)) missing.push(q);
  return { answers, missing };
}

// Fallback for answers sent as lines "Q1: answer" (seen live on 10.11): no quotes in this form.
// Returns null if no line has that shape.
function parseAnswerLines(text) {
  const items = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^Q(\d+)\s*[:.)-]\s*(.+)$/i);
    if (m) items.push({ q: Number(m[1]), answer: m[2], quote: '' });
  }
  return items.length ? items : null;
}

// Why a run must refuse this step, or null if it takes it. The order is fixed:
// answers (status "reading" -> "answered"), then findings ("answered" -> "checked"),
// each once per run and only from the person who started the run.
export function runRefusal(run, step, { pageId, runId, accountId }) {
  if (!run) return `There is no cold read ${runId} of page ${pageId}. Call get-cold-read-packet first.`;
  if (run.startedBy && run.startedBy !== accountId) return 'This cold read was started by another person.';
  const ready = step === 'answers' ? 'reading' : 'answered';
  if (run.status !== ready) {
    if (step === 'answers') {
      return `Answers to cold read ${runId} are already saved. Start a new cold read to answer again.`;
    }
    if (run.status === 'reading') return `Submit the answers to cold read ${runId} first.`;
    return `Findings of cold read ${runId} are already saved. Start a new cold read to check again.`;
  }
  // With expected answers the run is a test of the page; without them it is checked by a warm read.
  const hasExpected = run.questions.some((q) => q.expected);
  if (step === 'warm' && hasExpected) {
    return `Cold read ${runId} has expected answers: compare with them, a warm read is not needed.`;
  }
  if (step === 'findings' && !hasExpected && !run.warm) {
    return `Call get-warm-read-packet for cold read ${runId} first.`;
  }
  return null;
}

// Search terms for the warm read: the distinctive words of the page title.
const STOP_WORDS = new Set(
  'a an and the of to for in on at by with from or is are be our we notes note page draft handoff hand off'.split(' '),
);
export function searchTerms(title) {
  const words = String(title || '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
  return [...new Set(words)].slice(0, 6);
}

// CQL for pages that share at least `minShared` (1 or 2) of the terms, without the page itself.
// Terms are letters and digits only (searchTerms), so they need no escaping.
export function relatedCql(pageId, terms, minShared = 1) {
  const has = (t) => `text ~ "${t}"`;
  let match = terms.map(has).join(' OR ');
  if (minShared === 2 && terms.length >= 2) {
    const pairs = [];
    for (let i = 0; i < terms.length; i += 1) {
      for (let j = i + 1; j < terms.length; j += 1) pairs.push(`(${has(terms[i])} AND ${has(terms[j])})`);
    }
    match = pairs.join(' OR ');
  }
  return `type = page AND id != ${pageId} AND (${match})`;
}

// Expected answers the reader gets once its answers are saved: only questions that have one.
// q is the question number in the run, the same number the reader answered.
export function expectedOf(run) {
  return run.questions
    .map((question, i) => ({ q: i + 1, question: question.text, expected: question.expected || '' }))
    .filter((item) => item.expected);
}

// Parses the findings the agent sends to submit-cold-read-findings:
// a JSON array of {"q": number, "verdict": "match" | "A" | "B" | "C", "note": string}.
// Only questions in `allowed` (those with an expected answer) count.
export function parseFindings(raw, allowed) {
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (data && !Array.isArray(data) && Array.isArray(data.findings)) data = data.findings;
  if (!Array.isArray(data)) {
    return { error: 'findings must be a JSON array of {"q": number, "verdict": "match" | "A" | "B" | "C", "note": string}.' };
  }
  const byNumber = new Map();
  for (const item of data) {
    const q = Number(item?.q);
    if (!allowed.has(q) || byNumber.has(q)) continue;
    const v = String(item?.verdict ?? '').trim();
    const verdict = /^match/i.test(v) ? 'match' : (v.match(/^([ABC])\b/i)?.[1] ?? '').toUpperCase();
    if (!verdict) continue;
    byNumber.set(q, { q, verdict, note: String(item?.note ?? '').trim().slice(0, MAX_ANSWER_CHARS) });
  }
  if (byNumber.size === 0) {
    return { error: 'No valid findings found. Give a verdict for each question that has an expected answer.' };
  }
  return { findings: [...byNumber.values()].sort((a, b) => a.q - b.q) };
}

// What the latest cold read says about acting on the page now: one line for an agent or a person.
export function statusAdvice(run, pageVersion) {
  if (!run) return 'No cold read yet. Run one before relying on this page.';
  if (run.pageVersion < pageVersion) {
    return `The page changed after the last cold read (version ${run.pageVersion}, now ${pageVersion}). Run a new one before acting on it.`;
  }
  if (run.status !== 'checked') return 'The last cold read did not finish. Run a new one.';
  const a = (run.findings ?? []).filter((f) => f.verdict === 'A').length;
  if (a > 0) return `Do not act on this page yet: ${a} class A finding(s), a newcomer would act wrongly. Ask the page owner to fix them.`;
  return 'The last cold read of this version found no class A problems.';
}

// Title and tooltip of the "Cold Read" item under the page title: the latest result at a glance.
export function bylineStatus(run, pageVersion) {
  if (!run || run.status !== 'checked') {
    return { title: 'Cold Read', tooltip: 'What would a newcomer understand from this page?' };
  }
  if (pageVersion && run.pageVersion < pageVersion) {
    return { title: 'Cold Read · page changed', tooltip: `The last cold read checked version ${run.pageVersion}. Run a new one.` };
  }
  const n = (v) => (run.findings ?? []).filter((f) => f.verdict === v).length;
  const [a, b, c] = [n('A'), n('B'), n('C')];
  const tooltip = `Last cold read: ${a} A, ${b} B, ${c} C.`;
  if (a) return { title: `Cold Read · ${a} A`, tooltip: `${tooltip} A newcomer would act wrongly.` };
  if (b + c) return { title: `Cold Read · ${b + c} to fix`, tooltip };
  return { title: 'Cold Read · clear', tooltip: 'The last cold read of this version found no problems.' };
}

// Run IDs sort by time: base-36 milliseconds plus a short random tail against collisions.
export function newRunId(now = Date.now()) {
  return now.toString(36) + Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

export const isRunId = (value) => /^[a-z0-9]{8,20}$/.test(String(value ?? ''));
export const isPageId = (value) => /^\d{1,20}$/.test(String(value ?? ''));
