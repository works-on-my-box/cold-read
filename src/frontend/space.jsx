// The Cold Read space page: every page of the space with Cold Read questions or runs, worst first, and the sample:
// "Load sample handoffs" while it is not loaded (the first thing to do in a space with no checked pages),
// "Remove sample" once it is.
import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, DynamicTable, EmptyState, Inline, Label, Link, Lozenge, SectionMessage, Select, Spinner, Stack, Strong, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { sampleOffer } from '../sample';

const APPEARANCE = { A: 'removed', changed: 'moved', fix: 'moved', unfinished: 'default', none: 'default', clear: 'success' };
const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const errorText = (e) => String(e?.message || e);

const SAMPLE_LINES = [
  'A fresh reader answers five handoff questions from the page alone. Then Cold Read compares the answers with the Jira issues and pages the page links to.',
  'The sample adds a week of on-call handoffs of a made-up payments team to this space, and two Jira issues to the project you choose.',
  'Nothing runs until you open a handoff, click Cold Read under its title and then Run cold read.',
];

// The Jira project for the sample's two issues (the one last used in this space first) and the button.
function SampleLoader({ primary, onDone }) {
  const [projects, setProjects] = useState(null); // null = loading
  const [projectId, setProjectId] = useState(null);
  const [error, setError] = useState(null);
  const [notConnected, setNotConnected] = useState(null); // the one sentence when Cold Read cannot reach Jira here
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke('getJiraProjects')
      .then((res) => {
        if (res?.notConnected) {
          setNotConnected(res.error);
          setProjects([]);
          return;
        }
        if (res?.error) throw new Error(res.error);
        setProjects(res.projects);
        setProjectId(res.defaultProjectId);
      })
      .catch((e) => {
        setError(errorText(e));
        setProjects([]);
      });
  }, []);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke('loadSample', { projectId });
      if (res?.error) setError(res.error);
      if (res?.sample || !res?.error) onDone({ kind: 'loaded', already: res?.already });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (projects === null) return <Spinner label="Loading Jira projects" />;
  const options = projects.map((p) => ({ label: `${p.name} (${p.key})`, value: p.id }));
  return (
    <Stack space="space.100">
      {projects.length ? (
        <>
          <Label labelFor="sample-project">Jira project for the two sample issues</Label>
          <Select inputId="sample-project" options={options} defaultValue={options.find((o) => o.value === projectId)} onChange={(o) => setProjectId(o?.value ?? null)} />
          <Inline space="space.100" alignBlock="center">
            <Button appearance={primary ? 'primary' : 'default'} onClick={load} isDisabled={!projectId || busy}>Load sample handoffs</Button>
            {busy ? <Spinner size="small" label="Loading the sample" /> : null}
          </Inline>
        </>
      ) : (
        <Text>{notConnected ?? 'The sample needs a Jira project where you can create issues on this site.'}</Text>
      )}
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
    </Stack>
  );
}

// What the sample put into the space, and "Remove sample".
function SampleBox({ sample, onDone }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const main = sample.pages[0];

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke('removeSample');
      if (res?.error) setError(res.error);
      else onDone({ kind: 'removed', ...res });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack space="space.100">
      {sample.state === 'loaded' ? (
        <SectionMessage appearance="information" title="Sample handoffs are in this space">
          <Text>
            Start with {main?.url ? <Link href={main.url}>{main.title}</Link> : main?.title}: click Cold Read under its title, then Run cold read.
          </Text>
          <Text>Jira issues of the sample: {sample.issues.join(', ')}.</Text>
        </SectionMessage>
      ) : null}
      {sample.state === 'loading' ? <Text>The sample is loading. Refresh this page in a minute.</Text> : null}
      {sample.state === 'failed' ? (
        <SectionMessage appearance="warning" title="The sample did not finish loading">
          <Text>{sample.error}</Text>
          <Text>Remove sample takes away what it created.</Text>
        </SectionMessage>
      ) : null}
      {sample.state !== 'loading' ? (
        <Inline space="space.100" alignBlock="center">
          <Button onClick={remove} isDisabled={busy}>Remove sample</Button>
          {busy ? <Spinner size="small" label="Removing the sample" /> : null}
        </Inline>
      ) : null}
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
    </Stack>
  );
}

// What Remove sample did: the issues, and the pages the person deletes themselves.
function Removed({ result }) {
  const { removed, pagesLeft } = result;
  return (
    <SectionMessage appearance={removed.failed.length || removed.commented.length || removed.missing.length ? 'warning' : 'success'} title="Sample removed from Cold Read">
      {removed.deleted.length ? <Text>Deleted Jira issues: {removed.deleted.join(', ')}.</Text> : null}
      {removed.missing.length ? <Text>Not found in Jira (already deleted, or you cannot see them): {removed.missing.join(', ')}.</Text> : null}
      {removed.closed.length ? <Text>Closed, with a comment (you may not delete issues in this project): {removed.closed.join(', ')}.</Text> : null}
      {removed.commented.length ? <Text>Commented, not closed (no transition to a done status for you here): {removed.commented.join(', ')}.</Text> : null}
      {removed.failed.length ? <Text>Could not delete or close: {removed.failed.join(', ')}.</Text> : null}
      {pagesLeft ? (
        <Text>
          Cold Read has no permission to delete pages. Open {pagesLeft.url ? <Link href={pagesLeft.url}>{pagesLeft.title}</Link> : pagesLeft.title} and delete this page with its children.
        </Text>
      ) : null}
    </SectionMessage>
  );
}

const App = () => {
  const [data, setData] = useState(null);
  const [result, setResult] = useState(null);

  const refresh = () =>
    invoke('getSpaceSummary')
      .then(setData)
      .catch((e) => setData({ error: errorText(e) }));

  useEffect(() => {
    refresh();
  }, []);

  if (!data) return <Spinner label="Loading Cold Read" />;
  if (data.error) {
    return (
      <SectionMessage appearance="error" title="Cold Read could not load">
        <Text>{data.error}</Text>
      </SectionMessage>
    );
  }

  const done = (r) => {
    setResult(r.kind === 'removed' ? r : null);
    refresh();
  };
  const sample = data.sample ?? { state: 'none' };
  const offer = sampleOffer(data.pages.length, sample.state);

  const head = {
    cells: [
      { key: 'page', content: 'Page' },
      { key: 'state', content: 'Last cold read' },
      { key: 'when', content: 'When' },
      { key: 'questions', content: 'Questions' },
      { key: 'jira', content: 'Fix in Jira' },
    ],
  };
  const rows = data.pages.map((p) => ({
    key: p.pageId,
    cells: [
      { key: 'page', content: p.url ? <Link href={p.url}>{p.title}</Link> : p.title },
      { key: 'state', content: <Lozenge appearance={APPEARANCE[p.state.key]}>{p.state.label}</Lozenge> },
      { key: 'when', content: formatTime(p.checkedAt) },
      {
        key: 'questions',
        content: p.isDefault ? `${p.questions} (default set)` : `${p.questions}, ${p.withExpected} with expected answers`,
      },
      { key: 'jira', content: p.jira ? (p.jira.url ? <Link href={p.jira.url} openNewTab>{p.jira.key}</Link> : p.jira.key) : '' },
    ],
  }));

  return (
    <Stack space="space.200">
      <Text>Pages of this space checked by a fresh reader. A means a newcomer following the page would act wrongly; open the page and its Cold Read to see why.</Text>
      {result ? <Removed result={result} /> : null}
      {rows.length ? <DynamicTable head={head} rows={rows} /> : null}
      {offer === 'primary' ? (
        <Stack space="space.100">
          <EmptyState header="No checked pages yet" description="Open a page and click Cold Read under its title, or start with the sample." />
          {SAMPLE_LINES.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
          <SampleLoader primary onDone={done} />
        </Stack>
      ) : null}
      {offer === 'secondary' ? (
        <Stack space="space.100">
          <Text>
            <Strong>Sample handoffs.</Strong> {SAMPLE_LINES[1]}
          </Text>
          <SampleLoader onDone={done} />
        </Stack>
      ) : null}
      {sample.state !== 'none' ? <SampleBox sample={sample} onDone={done} /> : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
