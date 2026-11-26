// Confluence REST calls. All of them run as the user (asUser), so Confluence itself
// checks that the person can see the page: the reader never sees more than they can.
import api, { route } from '@forge/api';
import { storageToText, pageLinks, titleCql } from './logic';

// Returns { id, title, version, status, text?, links? } or { error, status }; status: the page's own ('current', or
// 'trashed' for a page in the trash), and on an error the HTTP status; links: the pages and Jira issues the page names
// itself (pageLinks), the first sources of a warm read.
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
    status: page.status,
    spaceId: String(page.spaceId),
    ownerId: page.ownerId,
    webui: page._links?.webui,
    url: page._links?.base && page._links?.webui ? page._links.base + page._links.webui : undefined,
    text: withBody ? storageToText(page.body?.storage?.value) : undefined,
    links: withBody ? pageLinks(page.body?.storage?.value) : undefined,
  };
}

// True if the user may edit the page. Only editors may change its questions.
export async function canEditPage(pageId) {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${pageId}/operations`);
  if (!res.ok) return false;
  const { operations = [] } = await res.json();
  return operations.some((op) => op.operation === 'update' && op.targetType === 'page');
}

// Pages found by CQL as the user (a link by title to another space): only what they can see.
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

// The page a link names by its title: in the space the link names (CQL by space key), or else in the space of the
// page itself (by space id). Returns [{ id, title }] (at most one) or { error }.
export async function pageByTitle(title, { spaceKey, spaceId } = {}) {
  if (spaceKey) return searchPages(titleCql(title, spaceKey), 1);
  if (!spaceId) return [];
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages?title=${title}&space-id=${spaceId}&limit=1`);
  if (!res.ok) return { error: `Confluence returned ${res.status} for a page by its title` };
  const { results = [] } = await res.json();
  return results.map((p) => ({ id: String(p.id), title: p.title }));
}

// Creates a page as the user (Confluence checks they may add pages to the space): under parentId, or at the top of
// the space's page tree under its homepage. Returns { id, title, url, base } or { error, status }.
export async function createPage({ spaceId, parentId, title, body }) {
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId, status: 'current', title, ...(parentId ? { parentId } : {}), body: { representation: 'storage', value: body } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const detail = /"(?:title|message)"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
    return { error: `Confluence returned ${res.status} for the new page "${title}"${detail ? `: ${detail}` : '.'}`, status: res.status };
  }
  const page = await res.json();
  const base = page._links?.base;
  return { id: String(page.id), title: page.title, base, url: base && page._links?.webui ? base + page._links.webui : undefined };
}
