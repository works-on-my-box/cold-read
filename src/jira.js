// Jira REST calls. All of them run as the user (asUser), so Jira itself checks what the person
// may see and create. They need the app installed in Jira on the same site as well as in Confluence.
import api, { route, NeedsAuthenticationError } from '@forge/api';
import { adfToText, projectListRefusal } from './logic';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

// requestJira throws when the app cannot reach Jira on this site (for example, not installed there).
async function call(path, init) {
  try {
    return await api.asUser().requestJira(path, init);
  } catch (e) {
    if (e instanceof NeedsAuthenticationError) throw e; // the platform then asks the person to allow access
    return { ok: false, status: 0, json: async () => ({ errorMessages: [String(e?.message || e)] }) };
  }
}

async function errorOf(res, what) {
  const body = await res.json().catch(() => ({}));
  const details = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join(' ');
  return `Jira returned ${res.status || 'no answer'} for ${what}${details ? `: ${details}` : '.'}`;
}

// Projects where the person can create issues: [{ id, key, name }] or { error } ({ error, notConnected } when Cold Read
// cannot reach Jira on this site).
export async function creatableProjects() {
  const res = await call(route`/rest/api/3/project/search?action=create&orderBy=name&maxResults=50`);
  if (!res.ok) return projectListRefusal(res.status, await errorOf(res, 'the project list'));
  const { values = [] } = await res.json();
  return values.map((p) => ({ id: String(p.id), key: p.key, name: p.name }));
}

// The issue type for a fix: "Task" if the project has it, else its first type that is not a sub-task.
async function taskTypeId(projectId) {
  const res = await call(route`/rest/api/3/issue/createmeta/${projectId}/issuetypes`);
  if (!res.ok) return { error: await errorOf(res, 'the issue types of the project') };
  const data = await res.json();
  const types = (data.issueTypes ?? data.values ?? []).filter((t) => !t.subtask);
  const type = types.find((t) => t.name === 'Task') ?? types[0];
  return type ? { id: String(type.id) } : { error: 'This Jira project has no issue type for a task.' };
}

// Creates the issue, assigned to assigneeId. Projects may not allow that person as assignee or have no
// labels field: then the issue is created without them. Returns { key, assigned } or { error }.
// labels: 'cold-read' for the issue about findings (the warm read leaves those out); the sample gives its own.
export async function createIssue({ projectId, summary, description, assigneeId, labels = ['cold-read'] }) {
  const type = await taskTypeId(projectId);
  if (type.error) return type;
  const fields = { project: { id: projectId }, issuetype: { id: type.id }, summary, description, labels };
  if (assigneeId) fields.assignee = { id: assigneeId };

  const post = (f) => call(route`/rest/api/3/issue`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ fields: f }) });
  let res = await post(fields);
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    const rejected = Object.keys(body.errors ?? {});
    if (rejected.length === 0 || rejected.some((k) => !['assignee', 'labels'].includes(k))) {
      return { error: `Jira returned 400 for the new issue: ${[...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join(' ')}` };
    }
    rejected.forEach((k) => delete fields[k]);
    res = await post(fields);
  }
  if (!res.ok) return { error: await errorOf(res, 'the new issue') };
  const { key } = await res.json();
  return { key, assigned: Boolean(fields.assignee) };
}

// An issue with its description and comments as text.
const issueOf = (i) => ({
  key: i.key,
  summary: i.fields?.summary ?? '',
  status: i.fields?.status?.name ?? '',
  labels: i.fields?.labels ?? [],
  text: [adfToText(i.fields?.description), ...(i.fields?.comment?.comments ?? []).map((c) => adfToText(c.body))]
    .filter(Boolean)
    .join('\n\n'),
});

// One issue a page names by its key: { key, summary, status, labels, text } or { error } (no such issue, or the
// person cannot see it).
export async function fetchIssue(key) {
  const res = await call(route`/rest/api/3/issue/${key}?fields=summary,status,description,comment,labels`);
  if (!res.ok) return { error: await errorOf(res, `issue ${key}`) };
  return issueOf(await res.json());
}

// Whether the person can open an issue: only its summary is asked for, and it is not kept.
export async function canSeeIssue(key) {
  const res = await call(route`/rest/api/3/issue/${key}?fields=summary`);
  return res.ok;
}

// A comment (ADF) on an issue: { ok } or { error }.
export async function addComment(key, body) {
  const res = await call(route`/rest/api/3/issue/${key}/comment`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body }) });
  return res.ok ? { ok: true } : { error: await errorOf(res, `a comment on ${key}`) };
}

// Deletes an issue: { ok } or { status, error } (403 without the Delete issues permission, 404 if it is gone).
export async function deleteIssue(key) {
  const res = await call(route`/rest/api/3/issue/${key}`, { method: 'DELETE' });
  return res.ok ? { ok: true } : { status: res.status, error: await errorOf(res, `deleting ${key}`) };
}

// An issue that may not be deleted: a comment, then a transition to a status of the done category if the workflow
// has one. Returns { ok, closed } or { error }.
export async function closeIssue(key, comment) {
  const commented = await addComment(key, comment);
  if (commented.error) return commented;
  const res = await call(route`/rest/api/3/issue/${key}/transitions`);
  if (!res.ok) return { ok: true, closed: false };
  const { transitions = [] } = await res.json();
  const done = transitions.find((t) => t.to?.statusCategory?.key === 'done');
  if (!done) return { ok: true, closed: false };
  const moved = await call(route`/rest/api/3/issue/${key}/transitions`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ transition: { id: done.id } }) });
  return { ok: true, closed: moved.ok };
}
