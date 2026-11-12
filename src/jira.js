// Jira REST calls. All of them run as the user (asUser), so Jira itself checks what the person
// may see and create. They need the app installed in Jira on the same site as well as in Confluence.
import api, { route } from '@forge/api';
import { adfToText } from './logic';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

// requestJira throws when the app cannot reach Jira on this site (for example, not installed there).
async function call(path, init) {
  try {
    return await api.asUser().requestJira(path, init);
  } catch (e) {
    return { ok: false, status: 0, json: async () => ({ errorMessages: [String(e?.message || e)] }) };
  }
}

async function errorOf(res, what) {
  const body = await res.json().catch(() => ({}));
  const details = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join(' ');
  return `Jira returned ${res.status || 'no answer'} for ${what}${details ? `: ${details}` : '.'}`;
}

// Projects where the person can create issues: [{ id, key, name }] or { error }.
export async function creatableProjects() {
  const res = await call(route`/rest/api/3/project/search?action=create&orderBy=name&maxResults=50`);
  if (!res.ok) return { error: await errorOf(res, 'the project list') };
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
export async function createIssue({ projectId, summary, description, assigneeId }) {
  const type = await taskTypeId(projectId);
  if (type.error) return type;
  const fields = { project: { id: projectId }, issuetype: { id: type.id }, summary, description, labels: ['cold-read'] };
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

// Issues found by JQL, with description and comments as text: [{ key, summary, status, text }] or { error }.
export async function searchIssues(jql, limit = 5) {
  const res = await call(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ jql, maxResults: limit, fields: ['summary', 'status', 'description', 'comment'] }),
  });
  if (!res.ok) return { error: await errorOf(res, 'the issue search') };
  const { issues = [] } = await res.json();
  return issues.map((i) => ({
    key: i.key,
    summary: i.fields?.summary ?? '',
    status: i.fields?.status?.name ?? '',
    text: [adfToText(i.fields?.description), ...(i.fields?.comment?.comments ?? []).map((c) => adfToText(c.body))]
      .filter(Boolean)
      .join('\n\n'),
  }));
}
