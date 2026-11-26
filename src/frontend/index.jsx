// The Cold Read panel. It opens from "Cold Read" under the page title.
// Tab "Last run": "Run cold read" (backend steps, autoRunCold then autoRunCompare - once with expected answers, twice in
// a warm read), the reader's answers next to the expected answers or next to the answers with the linked sources. Tab "Questions": edit them. The agent in the Rovo chat stays the second way to run it.
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
  List,
  ListItem,
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
import { modelName } from './model-names';
import { warmLine, sourceName, findingRow } from './warm-sources';

const AGENT = { type: 'forge', agentKey: 'cold-reader', agentName: 'Cold Reader' };
const MAX_QUESTIONS = 10; // the same limit as src/logic.js
const PAGE_CHARS = '40,000'; // PAGE_CHARS of src/logic.js

// What the panel shows while a one-click run goes: the cold step, then the steps by what it compares with
// (a warm read has three: the answers again with the linked Jira issues and pages, then the check for conflicts).
const STEP_TEXT = {
  cold: '1 of 2 · A fresh reader is answering from this page alone',
  'cold warm': '1 of 3 · A fresh reader is answering from this page alone',
  'expected answers': '2 of 2 · Comparing with the answers you expect',
  'warm answers': '2 of 3 · Answering again with the Jira issues and pages this page links to',
  'warm compare': '3 of 3 · Checking where the page and its linked issues and pages disagree',
};

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

// One answer of a warm read's step 2: the answer, then each linked source it rests on with its quote.
function WarmCell({ answer }) {
  if (!answer) return <Lozenge appearance="removed">No answer</Lozenge>;
  if (answer.notStated && !answer.sources.length) {
    const rest = answer.answer.replace(/^NOT STATED[\s.:;,-]*/i, '');
    return (
      <Stack space="space.050">
        <Lozenge appearance="removed">Not stated</Lozenge>
        {rest ? <Text>{rest.charAt(0).toUpperCase() + rest.slice(1)}</Text> : null}
      </Stack>
    );
  }
  return (
    <Stack space="space.050">
      <Text>{answer.answer}</Text>
      {answer.sources.map((s) => (
        <Text key={s.issueKey ?? s.pageId}>
          <Em>{sourceName(s)}: “{s.quote}”</Em>
        </Text>
      ))}
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

// A conflict of a warm read is an A finding with two quotes: the page, then the linked source that says otherwise. One
// finding per linked source may touch several questions: each of their rows shows it with that question's own quotes
// and sentence (findingRow).
function FindingCell({ row }) {
  if (!row) return <Text> </Text>;
  const { finding, part } = row;
  const v = VERDICTS[finding.verdict];
  return (
    <Stack space="space.050">
      <Lozenge appearance={v.appearance}>{v.label}</Lozenge>
      {part.quotes ? (
        <Stack space="space.050">
          <Text><Strong>Page:</Strong> <Em>“{part.quotes.page}”</Em></Text>
          <Text><Strong>{sourceName(part.quotes.source)}:</Strong> <Em>“{part.quotes.source.quote}”</Em></Text>
        </Stack>
      ) : null}
      {part.note ? <Text>{part.note}</Text> : null}
      {finding.questions?.length > 1 ? <Text size="small" color="color.text.subtle">One finding for questions {finding.questions.join(', ')}</Text> : null}
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
  const [notConnected, setNotConnected] = useState(null); // the one sentence when Cold Read cannot reach Jira here
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (run.jira) return;
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
  if (notConnected) return <Text>{notConnected}</Text>;
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
      <Text><Strong>Send the A findings to the page owner.</Strong> One Jira issue lists them, with a link to this page. Everyone who can see the project you pick can read it.</Text>
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

// What is left of the site's one-click runs: one quiet line, only when few are left (getState sends runsLeft then).
const runsLeftText = (n) =>
  n > 0 ? `About ${n} one-click run${n === 1 ? '' : 's'} left on this site for now.` : 'One-click runs on this site are nearly used up for now: the next one may be refused. It refills over time.';

// A one-click run under way: the step with the seconds since the run started, counted here in the browser, and under
// it the questions the reader is answering (the saved ones, as on the Questions tab).
function RunProgress({ progress, since, questions }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - (since ?? now)) / 1000));
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Spinner size="small" label="Cold read running" />
        <Text>{STEP_TEXT[progress]} · {seconds} s</Text>
      </Inline>
      <List type="ordered">
        {questions.map((q) => (
          <ListItem key={q.id}>{q.text}</ListItem>
        ))}
      </List>
    </Stack>
  );
}

// Where a one-click run stands, or why it stopped, with the way on.
function RunNotice({ state, progress, since, problem, rovoEnabled, onRun, onContinue, onChat, runDisabled }) {
  if (progress) return <RunProgress progress={progress} since={since} questions={state.questions} />;
  // The spend limit, or the one-click run switched off for this site: the words come from the backend.
  if (problem?.kind === 'refused') {
    return (
      <SectionMessage appearance="warning">
        <Stack space="space.100">
          <Text>{problem.text}</Text>
          {rovoEnabled === true ? (
            <Inline>
              <Button onClick={onChat} isDisabled={runDisabled}>Run in Rovo chat</Button>
            </Inline>
          ) : null}
        </Stack>
      </SectionMessage>
    );
  }
  if (problem) {
    return (
      <SectionMessage appearance="error">
        <Stack space="space.100">
          <Text>{problem.text}</Text>
          <Inline>
            <Button onClick={onRun} isDisabled={runDisabled}>Try again</Button>
          </Inline>
        </Stack>
      </SectionMessage>
    );
  }
  if (state.interrupted) {
    return (
      <SectionMessage appearance="warning">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Text>A cold read was interrupted.</Text>
          <Button onClick={() => onContinue(state.interrupted)} isDisabled={runDisabled}>Continue</Button>
        </Inline>
      </SectionMessage>
    );
  }
  if (state.runsLeft != null) return <Text><Em>{runsLeftText(state.runsLeft)}</Em></Text>;
  return null;
}

function LastRun({ state, progress, since, problem, rovoEnabled, onRun, onContinue, onChat, onRefresh, onJira, runDisabled }) {
  const run = state.lastRun;
  const pageChanged = run && state.pageVersion && run.pageVersion && state.pageVersion > run.pageVersion;
  const buttons = (
    <ButtonGroup label="Run">
      <Button appearance="primary" onClick={onRun} isDisabled={runDisabled}>{pageChanged ? 'Run again' : 'Run cold read'}</Button>
      {rovoEnabled === true ? <Button appearance="subtle" onClick={onChat} isDisabled={runDisabled}>Run in Rovo chat</Button> : null}
      <Button onClick={onRefresh} isDisabled={!!progress}>Refresh</Button>
    </ButtonGroup>
  );
  const notice = (
    <RunNotice state={state} progress={progress} since={since} problem={problem} rovoEnabled={rovoEnabled} onRun={onRun} onContinue={onContinue} onChat={onChat} runDisabled={runDisabled} />
  );
  if (!run) {
    return (
      <Stack space="space.200">
        {notice}
        <EmptyState
          header="No cold read yet"
          description="Check the questions in the Questions tab, then run a cold read."
          primaryAction={buttons}
        />
      </Stack>
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
  const count = (v) => findings.filter((f) => f.verdict === v).length;

  // A warm read of a one-click run keeps its second answers: they stand where the expected answers stand.
  const warmAnswers = !hasExpected && run.warm?.answers ? run.warm.answers : null;
  const usedNames = (run.warm?.sources ?? []).filter((s) => s.used).map(sourceName);
  const head = {
    cells: [
      { key: 'n', content: '#' },
      { key: 'q', content: 'Question' },
      { key: 'a', content: warmAnswers ? 'From the page alone' : 'Cold reader’s answer' },
      ...(hasExpected ? [{ key: 'e', content: 'Expected answer' }] : []),
      ...(warmAnswers ? [{ key: 'w', content: usedNames.length ? `With ${usedNames.join(', ')}` : 'With the linked issues and pages' }] : []),
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
      ...(warmAnswers ? [{ key: 'w', content: <WarmCell answer={warmAnswers.find((a) => a.q === i + 1)} /> }] : []),
      ...(findings.length ? [{ key: 'f', content: <FindingCell row={findingRow(findings, i + 1, q.id)} /> }] : []),
    ],
  }));

  return (
    <Stack space="space.200">
      {buttons}
      {notice}
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
            The answers are saved and the reader is comparing them with {hasExpected ? 'the expected answers' : 'the Jira issues and pages this page links to'}. If the Rovo chat asks to confirm “Submit cold read findings”, confirm it, then press Refresh.
          </Text>
        </SectionMessage>
      ) : null}
      {run.clipped ? (
        <SectionMessage appearance="information">
          <Text>This page is long: the first {PAGE_CHARS} characters were read.</Text>
        </SectionMessage>
      ) : null}
      {run.warm ? <Text>{warmLine(run.warm)}</Text> : null}
      {run.status !== 'reading' ? (
        <Text>
          <Strong>{fromPage}</Strong> of {run.questions.length} answered from the page · <Strong>{notStated}</Strong> not on the page
          {findings.length ? ` · findings: ${count('A')} A, ${count('B')} B, ${count('C')} C, ${count('match')} match` : ''}
        </Text>
      ) : null}
      <DynamicTable head={head} rows={rows} />
      {run.model ? (
        <Text size="small" color="color.text.subtle">Read by {modelName(run.model)} via Forge LLMs · fresh context · page version {run.pageVersion}</Text>
      ) : null}
      {run.status === 'checked' && count('A') > 0 ? <JiraBox run={run} onCreated={onJira} /> : null}
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
  const [progress, setProgress] = useState(null); // a one-click run under way: 'cold', then what step 2 compares with
  const [since, setSince] = useState(null); // when it started (ms)
  const [problem, setProblem] = useState(null); // why the last one-click run stopped: { kind: 'refused' | 'failed', text }

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

  // "Run in Rovo chat" and "Suggest questions" hand over to the agent in the Rovo chat. The panel is a modal over
  // the page: close it so the chat is in view.
  const openAgent = async (prompt) => {
    try {
      await rovo.open({ ...AGENT, prompt });
      await view.close();
    } catch (e) {
      setMessage({ appearance: 'error', text: `Could not open the Rovo chat: ${String(e?.message || e)}` });
    }
  };
  const onChat = () => openAgent(`Run a cold read of Confluence page ${state.pageId}.`);

  // The one-click run: step 1 (the cold read), then the comparison - one call with expected answers, two in a warm
  // read (the answers with the linked sources, then the compare) - one after the other, each its own call. A page
  // without expected answers that links to nothing ends with step 1.
  // from: an interrupted run whose answers are saved - only the steps left are taken, with no new cold read.
  const runSteps = async (from) => {
    setMessage(null);
    setProblem(null);
    setSince(Date.now());
    try {
      let runId = from?.runId;
      let compareWith = from?.compareWith;
      const warmed = Boolean(from?.warmed);
      if (!from) {
        setProgress(state.questions.some((q) => q.expected) ? 'cold' : 'cold warm');
        const cold = await invoke('autoRunCold');
        if (cold?.status === 'checked') {
          setState((prev) => ({ ...prev, lastRun: cold.run, interrupted: null }));
          return;
        }
        if (cold?.status !== 'answered') {
          setProblem({ kind: cold?.refused ? 'refused' : 'failed', text: cold?.error || 'The cold read failed.' });
          return;
        }
        runId = cold.runId;
        compareWith = cold.compareWith;
      }
      const warm = compareWith === 'warm read';
      setProgress(warm ? (warmed ? 'warm compare' : 'warm answers') : 'expected answers');
      let done = await invoke('autoRunCompare', { runId });
      if (done?.status === 'warmed') {
        setProgress('warm compare');
        done = await invoke('autoRunCompare', { runId });
      }
      if (done?.status !== 'checked') {
        setProblem({ kind: done?.refused ? 'refused' : 'failed', text: done?.error || 'The cold read failed.' });
        await load();
        return;
      }
      setState((prev) => ({ ...prev, lastRun: done.run, interrupted: null }));
    } catch (e) {
      setProblem({ kind: 'failed', text: `The cold read did not finish: ${String(e?.message || e)}` });
      await load(); // if the answers were saved, the panel offers Continue
    } finally {
      setProgress(null);
    }
  };
  const onRun = () => runSteps();
  const onContinue = (interrupted) => runSteps(interrupted);
  const onRefresh = () => {
    setProblem(null);
    load();
  };
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
      <Text>A fresh reader answers the questions from this page alone. Its answers are then compared with the answers you expect or, without them, with the Jira issues and pages this page links to. Where they differ, that is a finding.</Text>
      {rovoEnabled === false ? (
        <SectionMessage appearance="warning" title="Rovo is off on this site">
          <Text>Suggest questions and the cold read in the Rovo chat need Rovo. Run cold read works without it.</Text>
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
          <LastRun
            state={state}
            progress={progress}
            since={since}
            problem={problem}
            rovoEnabled={rovoEnabled}
            onRun={onRun}
            onContinue={onContinue}
            onChat={onChat}
            onRefresh={onRefresh}
            onJira={onJira}
            runDisabled={dirty || busy || !!progress}
          />
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
