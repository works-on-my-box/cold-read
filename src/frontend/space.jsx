// The Cold Read space page: every page of the space with Cold Read questions or runs, worst first.
import React, { useEffect, useState } from 'react';
import ForgeReconciler, { DynamicTable, EmptyState, Link, Lozenge, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

const APPEARANCE = { A: 'removed', changed: 'moved', fix: 'moved', unfinished: 'default', none: 'default', clear: 'success' };
const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

const App = () => {
  const [data, setData] = useState(null);

  useEffect(() => {
    invoke('getSpaceSummary')
      .then(setData)
      .catch((e) => setData({ error: String(e?.message || e) }));
  }, []);

  if (!data) return <Spinner label="Loading Cold Read" />;
  if (data.error) {
    return (
      <SectionMessage appearance="error" title="Cold Read could not load">
        <Text>{data.error}</Text>
      </SectionMessage>
    );
  }

  const head = {
    cells: [
      { key: 'page', content: 'Page' },
      { key: 'state', content: 'Last cold read' },
      { key: 'when', content: 'When' },
      { key: 'questions', content: 'Questions' },
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
    ],
  }));

  return (
    <Stack space="space.200">
      <Text>Pages of this space checked by a fresh reader. A means a newcomer following the page would act wrongly; open the page and its Cold Read to see why.</Text>
      {rows.length ? (
        <DynamicTable head={head} rows={rows} />
      ) : (
        <EmptyState header="No checked pages yet" description="Open a page and click Cold Read under its title to add questions and run a cold read." />
      )}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
