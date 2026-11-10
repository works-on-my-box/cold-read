// Backend of the Cold Read panel (the "Cold Read" item under the page title).
// The page ID always comes from the Forge context of the panel, never from the browser payload.
import Resolver from '@forge/resolver';
import { fetchPage, canEditPage } from './confluence';
import { getQuestions, saveQuestions, resetQuestions, getLastRun } from './store';
import { validateQuestions } from './logic';

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

export const handler = resolver.getDefinitions();
