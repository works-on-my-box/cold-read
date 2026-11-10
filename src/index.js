import api, { route } from '@forge/api';

// Spike S2/S3: the two Rovo actions of the Cold Reader agent.
// The questions are fixed here for the spike; the app will keep them per page.
const QUESTIONS = [
  'Where does the work stand right now?',
  'What is the single next step, and who does it?',
  'What has already been done that must not be repeated?',
  'Has the renewal email with the quote been sent to Acme?',
  'What is the quote amount?',
];

// Storage format (XHTML) to plain text: block tags become line breaks, the rest is dropped.
function storageToText(xhtml) {
  return xhtml
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

// Rovo passes action inputs as top-level payload fields.
export async function getPacket(payload) {
  const pageId = String(payload.pageId || '').trim();
  if (!/^\d+$/.test(pageId)) {
    return { error: 'pageId must be the numeric ID of a Confluence page' };
  }
  // asUser: the reader sees only what the person who asked can see.
  const res = await api
    .asUser()
    .requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`);
  if (!res.ok) {
    return { error: `Confluence returned ${res.status} for page ${pageId}` };
  }
  const page = await res.json();
  const text = storageToText(page.body?.storage?.value || '');
  console.log(`packet page=${pageId} title=${JSON.stringify(page.title)} chars=${text.length}`);
  return {
    pageId,
    title: page.title,
    pageText: text,
    questions: QUESTIONS.map((q, i) => ({ q: i + 1, question: q })),
    rule: 'Answer only from pageText. If pageText does not state it, answer exactly NOT STATED.',
  };
}

export async function submitAnswers(payload) {
  // The spike only logs the answers; `forge logs` shows them.
  console.log(`answers page=${payload.pageId} ${payload.answers}`);
  return { status: 'recorded', pageId: payload.pageId };
}
