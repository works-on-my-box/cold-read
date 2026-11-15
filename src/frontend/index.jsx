// The Cold Read panel. It opens from "Cold Read" under the page title.
// Tab "Last run": the reader's answers next to the expected answers. Tab "Questions": edit them.
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Button,
  ButtonGroup,
  DynamicTable,
  Em,
  EmptyState,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  Textfield,
} from '@forge/react';
import { invoke, rovo, view } from '@forge/bridge';

const AGENT = { type: 'forge', agentKey: 'cold-reader', agentName: 'Cold Reader' };
const MAX_QUESTIONS = 10; // the same limit as src/logic.js

const newQuestionId = () => `q${Date.now().toString(36)}`;
const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

// One cell of the reader's answer: a quote proves the answer came from the page.
function AnswerCell({ run, answer }) {
  if (!answer) {
    return run.status === 'reading' ? <Lozenge appearance="inprogress">Reading</Lozenge> : <Lozenge appearance="removed">No answer</Lozenge>;
  }
  if (answer.notStated) {
    const rest = answer.answer.replace(/^NOT STATED[\s.:;,-]*/i, '');
    const extra = rest.charAt(0).toUpperCase() + rest.slice(1);
    return (
      <Stack space="space.050">
        <Lozenge appearance="removed">Not on the page</Lozenge>
        {extra ? <Text>{extra}</Text> : null}
      </Stack>
    );
  }
  return (
    <Stack space="space.050">
      <Text>{answer.answer}</Text>
      {answer.quote ? <Text><Em>“{answer.quote}”</Em></Text> : null}
    </Stack>
  );
}

// Finding classes, worst first. A: the newcomer would act wrongly. B: wrong or stale. C: not covered.
const VERDICTS = {
  A: { appearance: 'removed', label: 'A · would act wrongly' },
  B: { appearance: 'moved', label: 'B · wrong or stale' },
  C: { appearance: 'new', label: 'C · not covered' },
  match: { appearance: 'success', label: 'Match' },
};

function FindingCell({ finding }) {
  if (!finding) return <Text> </Text>;
  const v = VERDICTS[finding.verdict];
  return (
    <Stack space="space.050">
      <Lozenge appearance={v.appearance}>{v.label}</Lozenge>
      {finding.note ? <Text>{finding.note}</Text> : null}
    </Stack>
  );
}

function RunStatus({ run }) {
  if (run.status === 'reading') return <Lozenge appearance="inprogress">Waiting for answers</Lozenge>;
  if (run.status === 'answered') return <Lozenge appearance="inprogress">Waiting for findings</Lozenge>;
  return <Lozenge appearance="success">Checked</Lozenge>;
}

// A findings go to the page owner as one Jira issue per run, with a link back to the page.
function JiraBox({ run, onCreated }) {
  const [projects, setProjects] = useState(null); // null = loading
  const [projectId, setProjectId] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (run.jira) return;
    invoke('getJiraProjects')
      .then((res) => {
        if (res?.error) throw new Error(res.error);
        setProjects(res.projects);
        setProjectId(res.defaultProjectId);
      })
      .catch((e) => {
        setLoadError(String(e?.message || e));
        setProjects([]);
      });
  }, [run.runId]);

  if (run.jira) {
    return (
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Lozenge appearance="success">In Jira</Lozenge>
        <Text>{run.jira.assigned ? 'Issue for the page owner:' : 'Issue (this project does not let it be assigned to the page owner):'}</Text>
        {run.jira.url ? <Link href={run.jira.url} openNewTab>{run.jira.key}</Link> : <Text>{run.jira.key}</Text>}
      </Inline>
    );
  }
  if (projects === null) return <Spinner label="Loading Jira projects" />;
  if (loadError) {
    return (
      <SectionMessage appearance="warning" title="Jira is not available">
        <Text>{loadError}</Text>
      </SectionMessage>
    );
  }
  if (projects.length === 0) return <Text>You cannot create issues in any Jira project on this site.</Text>;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke('createJiraIssue', { projectId, runId: run.runId });
      if (res?.error) setError(res.error);
      else onCreated(res.jira);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const options = projects.map((p) => ({ label: `${p.name} (${p.key})`, value: p.id }));
  return (
    <Stack space="space.100">
      <Text><Strong>Send the A findings to the page owner.</Strong> One Jira issue lists them, with a link to this page.</Text>
      <Label labelFor="jira-project">Jira project</Label>
      <Select inputId="jira-project" options={options} defaultValue={options.find((o) => o.value === projectId)} onChange={(o) => setProjectId(o?.value ?? null)} />
      <Inline>
        <Button appearance="primary" onClick={create} isDisabled={!projectId || busy}>Create Jira issue for the page owner</Button>
      </Inline>
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
    </Stack>
  );
}

function LastRun({ state, onRun, onRefresh, onJira, runDisabled }) {
  const run = state.lastRun;
  const buttons = (
    <ButtonGroup label="Run">
      <Button appearance="primary" onClick={onRun} isDisabled={runDisabled}>Run cold read</Button>
      <Button onClick={onRefresh}>Refresh</Button>
    </ButtonGroup>
  );
  if (!run) {
    return (
      <EmptyState
        header="No cold read yet"
        description="Check the questions in the Questions tab, then run a cold read. The reader opens in the Rovo chat."
        primaryAction={buttons}
      />
    );
  }

  // Runs keep the expected answers they were checked against; older runs fall back to the page's.
  const current = Object.fromEntries(state.questions.map((q) => [q.id, q.expected]));
  const expectedOf = (q) => ('expected' in q ? q.expected : current[q.id]);
  const hasExpected = run.questions.some((q) => expectedOf(q));
  const answers = run.answers ?? [];
  const findings = run.findings ?? [];
  const notStated = answers.filter((a) => a.notStated).length;
  const fromPage = answers.length - notStated;
  const pageChanged = state.pageVersion && run.pageVersion && state.pageVersion > run.pageVersion;
  const count = (v) => findings.filter((f) => f.verdict === v).length;

  const head = {
    cells: [
      { key: 'n', content: '#' },
      { key: 'q', content: 'Question' },
      { key: 'a', content: 'Cold reader’s answer' },
      ...(hasExpected ? [{ key: 'e', content: 'Expected answer' }] : []),
      ...(findings.length ? [{ key: 'f', content: 'Finding' }] : []),
    ],
  };
  const rows = run.questions.map((q, i) => ({
    key: q.id,
    cells: [
      { key: 'n', content: String(i + 1) },
      { key: 'q', content: q.text },
      { key: 'a', content: <AnswerCell run={run} answer={answers.find((a) => a.questionId === q.id)} /> },
      ...(hasExpected ? [{ key: 'e', content: expectedOf(q) ? expectedOf(q) : <Em>Not set</Em> }] : []),
      ...(findings.length ? [{ key: 'f', content: <FindingCell finding={findings.find((f) => f.questionId === q.id)} /> }] : []),
    ],
  }));

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <RunStatus run={run} />
        <Text>Read version {run.pageVersion} · {formatTime(run.checkedAt || run.answeredAt || run.startedAt)}</Text>
        {pageChanged ? <Lozenge appearance="moved">Page changed since this run</Lozenge> : null}
      </Inline>
      {run.status === 'reading' ? (
        <SectionMessage appearance="information">
          <Text>The reader has the page and is answering. If the Rovo chat asks to confirm “Submit cold read answers”, confirm it, then press Refresh.</Text>
        </SectionMessage>
      ) : null}
      {run.status === 'answered' ? (
        <SectionMessage appearance="information">
          <Text>
            The answers are saved and the reader is comparing them with {hasExpected ? 'the expected answers' : 'pages related to this one (warm read)'}. If the Rovo chat asks to confirm “Submit cold read findings”, confirm it, then press Refresh.
          </Text>
        </SectionMessage>
      ) : null}
      {run.warm ? (
        <Text>
          Warm read: {run.warm.sources.length ? `compared with ${run.warm.sources.map((p) => (p.issueKey ? `${p.issueKey} “${p.title}”` : `“${p.title}”`)).join(', ')}` : 'no related pages or Jira issues found'}.
        </Text>
      ) : null}
      {run.status !== 'reading' ? (
        <Text>
          <Strong>{fromPage}</Strong> of {run.questions.length} answered from the page · <Strong>{notStated}</Strong> not on the page
          {findings.length ? ` · findings: ${count('A')} A, ${count('B')} B, ${count('C')} C, ${count('match')} match` : ''}
        </Text>
      ) : null}
      <DynamicTable head={head} rows={rows} />
      {run.status === 'checked' && count('A') > 0 ? <JiraBox run={run} onCreated={onJira} /> : null}
      {buttons}
    </Stack>
  );
}

// The fields are uncontrolled (defaultValue): UI Kit sends every keystroke over the bridge,
// and a controlled value would be overwritten by a stale one while the person types.
// formKey remounts the fields when the questions are replaced (load, reset).
function Questions({ state, draft, setDraft, formKey, dirty, setDirty, busy, onSave, onReset, onSuggest, rovoEnabled }) {
  // Functional updates: several onChange events can arrive before the next render.
  const update = (id, field, value) => {
    setDraft((prev) => prev.map((q) => (q.id === id ? { ...q, [field]: value } : q)));
    setDirty(true);
  };
  const remove = (id) => {
    setDraft((prev) => prev.filter((q) => q.id !== id));
    setDirty(true);
  };
  const add = () => {
    setDraft((prev) => [...prev, { id: newQuestionId(), text: '', expected: '' }]);
    setDirty(true);
  };

  if (!state.canEdit) {
    return (
      <Stack space="space.150">
        <Text>Only people who can edit this page can change its questions.</Text>
        {state.questions.map((q, i) => (
          <Stack key={q.id} space="space.050">
            <Text><Strong>{i + 1}. {q.text}</Strong></Text>
            <Text>{q.expected ? q.expected : <Em>No expected answer</Em>}</Text>
          </Stack>
        ))}
      </Stack>
    );
  }

  return (
    <Stack space="space.200">
      {state.isDefault ? (
        <SectionMessage appearance="information">
          <Text>This page uses the default handoff questions. Change them and save to make them this page’s own.</Text>
        </SectionMessage>
      ) : null}
      <Text>Expected answers are optional. The Cold Reader gets them only after its answers are saved. Without them, Cold Read shows what the page leaves unsaid.</Text>
      {draft.map((q, i) => (
        <Stack key={`${formKey}-${q.id}`} space="space.050">
          <Label labelFor={`q-${q.id}`}>Question {i + 1}</Label>
          <Textfield id={`q-${q.id}`} defaultValue={q.text} maxLength={300} onChange={(e) => update(q.id, 'text', e.target.value)} />
          <Label labelFor={`e-${q.id}`}>Expected answer to question {i + 1}</Label>
          <TextArea id={`e-${q.id}`} defaultValue={q.expected} maxLength={1000} minimumRows={2} placeholder="What a newcomer should understand from the page" onChange={(e) => update(q.id, 'expected', e.target.value)} />
          <Inline>
            <Button appearance="subtle" onClick={() => remove(q.id)} isDisabled={draft.length <= 1}>Remove question {i + 1}</Button>
          </Inline>
        </Stack>
      ))}
      <ButtonGroup label="Questions">
        <Button appearance="primary" onClick={onSave} isDisabled={!dirty || busy}>Save questions</Button>
        <Button onClick={add} isDisabled={draft.length >= MAX_QUESTIONS || busy}>Add question</Button>
        <Button appearance="subtle" onClick={onReset} isDisabled={busy || (state.isDefault && !dirty)}>Use the handoff set</Button>
        <Button appearance="subtle" onClick={onSuggest} isDisabled={busy || dirty || rovoEnabled === false}>Suggest questions</Button>
      </ButtonGroup>
    </Stack>
  );
}

const App = () => {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState([]);
  const [formKey, setFormKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [rovoEnabled, setRovoEnabled] = useState(null); // null = not known yet

  const load = async () => {
    try {
      const next = await invoke('getState');
      setState(next);
      // Refresh keeps unsaved edits; only a clean form takes the stored questions.
      if (next?.questions && !dirty) {
        setDraft(next.questions);
        setFormKey((k) => k + 1);
        setDirty(false);
      }
    } catch (e) {
      setState({ error: String(e?.message || e) });
    }
  };

  useEffect(() => {
    load();
    rovo.isEnabled().then(setRovoEnabled).catch(() => setRovoEnabled(null));
  }, []);

  const call = async (name, payload, done) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await invoke(name, payload);
      if (res?.error) setMessage({ appearance: 'error', text: res.error });
      else done(res);
    } catch (e) {
      setMessage({ appearance: 'error', text: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const onSave = () =>
    call('saveQuestions', { questions: draft }, (res) => {
      setState((prev) => ({ ...prev, questions: res.questions, isDefault: false }));
      setDraft(res.questions);
      setDirty(false);
      setMessage({ appearance: 'success', text: 'Questions saved. The next cold read uses them.' });
    });

  const onReset = () =>
    call('resetQuestions', undefined, (res) => {
      setState((prev) => ({ ...prev, questions: res.questions, isDefault: true }));
      setDraft(res.questions);
      setFormKey((k) => k + 1);
      setDirty(false);
      setMessage({ appearance: 'success', text: 'The page uses the default handoff questions again.' });
    });

  // Both buttons hand over to the agent in the Rovo chat. The panel is a modal over the page:
  // close it so the chat is in view.
  const openAgent = async (prompt) => {
    try {
      await rovo.open({ ...AGENT, prompt });
      await view.close();
    } catch (e) {
      setMessage({ appearance: 'error', text: `Could not open the Rovo chat: ${String(e?.message || e)}` });
    }
  };
  const onRun = () => openAgent(`Run a cold read of Confluence page ${state.pageId}.`);
  const onJira = (jira) => setState((prev) => ({ ...prev, lastRun: { ...prev.lastRun, jira } }));
  const onSuggest = () => openAgent(`Suggest cold read questions for Confluence page ${state.pageId}.`);

  if (!state) return <Spinner label="Loading Cold Read" />;
  if (state.unsupported) {
    return (
      <SectionMessage appearance="information">
        <Text>Cold Read checks pages. Blog posts are not supported yet.</Text>
      </SectionMessage>
    );
  }
  if (state.error) {
    return (
      <SectionMessage appearance="error" title="Cold Read could not load">
        <Text>{state.error}</Text>
      </SectionMessage>
    );
  }

  return (
    <Stack space="space.200">
      <Text>A fresh Rovo agent answers the questions from this page alone. Its answers are then compared with the answers you expect or, without them, with related pages and Jira issues. Where they differ, a newcomer would go wrong too.</Text>
      {rovoEnabled === false ? (
        <SectionMessage appearance="warning" title="Rovo is off on this site">
          <Text>The cold reader is a Rovo agent, so it cannot run here. Questions and expected answers still save. Ask a site admin to turn on Rovo.</Text>
        </SectionMessage>
      ) : null}
      {message ? (
        <SectionMessage appearance={message.appearance}>
          <Text>{message.text}</Text>
        </SectionMessage>
      ) : null}
      {dirty ? <Text><Em>Save the questions first: the reader uses the saved ones.</Em></Text> : null}
      <Tabs id="cold-read-tabs">
        <TabList>
          <Tab>Last run</Tab>
          <Tab>Questions ({draft.length})</Tab>
        </TabList>
        <TabPanel>
          <LastRun state={state} onRun={onRun} onRefresh={load} onJira={onJira} runDisabled={dirty || busy || rovoEnabled === false} />
        </TabPanel>
        <TabPanel>
          <Questions state={state} draft={draft} setDraft={setDraft} formKey={formKey} dirty={dirty} setDirty={setDirty} busy={busy} onSave={onSave} onReset={onReset} onSuggest={onSuggest} rovoEnabled={rovoEnabled} />
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
