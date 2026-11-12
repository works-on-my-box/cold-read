// Confluence REST calls. All of them run as the user (asUser), so Confluence itself
// checks that the person can see the page: the reader never sees more than they can.
import api, { route } from '@forge/api';
import { storageToText } from './logic';

// Returns { id, title, version, text? } or { error, status }.
export async function fetchPage(pageId, { withBody = false } = {}) {
  const path = withBody
    ? route`/wiki/api/v2/pages/${pageId}?body-format=storage`
    : route`/wiki/api/v2/pages/${pageId}`;
  const res = await api.asUser().requestConfluence(path);
  if (!res.ok) {
    return { error: `Confluence returned ${res.status} for page ${pageId}`, status: res.status };
  }
  const page = await res.json();
  return {
    id: String(page.id),
    title: page.title,
    version: page.version?.number,
    spaceId: String(page.spaceId),
    ownerId: page.ownerId,
    webui: page._links?.webui,
    url: page._links?.base && page._links?.webui ? page._links.base + page._links.webui : undefined,
    text: withBody ? storageToText(page.body?.storage?.value) : undefined,
  };
}

// True if the user may edit the page. Only editors may change its questions.
export async function canEditPage(pageId) {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}/operations`);
  if (!res.ok) return false;
  const { operations = [] } = await res.json();
  return operations.some((op) => op.operation === 'update' && op.targetType === 'page');
}

// Pages related to the read page, found by CQL as the user: only what they can see.
// Returns [{ id, title }] or { error }.
export async function searchPages(cql, limit = 5) {
  const res = await api
    .asUser()
    .requestConfluence(route`/wiki/rest/api/search?cql=${cql}&limit=${limit}`);
  if (!res.ok) return { error: `Confluence search returned ${res.status}` };
  const { results = [] } = await res.json();
  return results
    .map((r) => r.content)
    .filter((c) => c?.id && c.type === 'page')
    .map((c) => ({ id: String(c.id), title: c.title }));
}
