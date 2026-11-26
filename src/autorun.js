// The one-click run of the panel: the steps of the Cold Reader agent taken by the backend through Forge LLMs.
// Each step is its own resolver call with one fresh model call (and one more if the first got no reply), so each fits the 25 s of a resolver:
//   cold    - rights, the switches (end date, src/guard-config.js, the feature flag), model and price, questions, the
//             spend limit with the reserve of all steps, startRun, the cold call (page text and questions only),
//             recordAnswers, markPending (so a closed panel can continue the run). A page without expected answers
//             that links to no Jira issue or page has nothing to compare with: the run ends here, without findings;
//   compare - the switches again (not the spend limit: a run started within it is taken to the end); with expected
//             answers the compare call (more than five questions: parts of up to five, called side by side), then
//             recordFindings; without them the warm read in two calls of compare:
//             step 2 - the linked Jira issues and pages (at most six), the answers again from the page and them, each
//                      with the sources it rests on, recordWarm (the sources marked used);
//             step 3 - three conflict checks of the two answers of each question, side by side (the sources read
//                      again); a conflict by two votes of three and with both quotes found is an A finding, the
//                      conflicts with one linked source are one finding (voteConflicts); then recordFindings.
// After each step its reserve is replaced by what its calls cost.
// No Forge imports here: the panel resolver passes in the Confluence, store, spend and model functions, the tests pass fakes.
// (The .js extension lets plain Node load this file in the tests.)
import {
  NO_MODEL,
  UNAVAILABLE,
  WARM_SOURCES,
  WARM_SOURCE_CHARS,
  budgetText,
  clipPage,
  coldPrompt,
  comparePrompt,
  compareParts,
  configRefusal,
  flagRefusal,
  hasLinks,
  runReserve,
  spendDay,
  usd,
  warmAnswersPrompt,
  conflictPrompt,
  parseConflicts,
  voteConflicts,
  CONFLICT_CALLS,
  parseWarmAnswers,
  markUsed,
  parseAnswers,
  parseFindings,
  expectedOf,
  runRefusal,
  continueRefusal,
  runForViewer,
  STEP_TAKEN,
} from './logic.js';

// A retry starts only this soon after the step began, so that it still ends inside the 25 s of a resolver.
const RETRY_WITHIN_MS = 12000;

export function makeAutoRun(deps) {
  const {
    fetchPage,
    findRelated,
    getQuestions,
    startRun,
    getRun,
    recordAnswers,
    recordWarm,
    recordFindings,
    recordFailure,
    markPending,
    claimStep,
    reserveSpend,
    settleSpend,
    pickModel,
    callModel,
    guardConfig,
    checkFlag = async () => null,
    installedAt = async () => NaN,
    elementsLogged = () => false,
    log = console.log,
    now = Date.now,
  } = deps;

  // One model call and the check of its reply; the call is made once more only if the first got no reply (it cost nothing).
  // Returns the checked value ({ answers, missing } or { findings }) or { error }, both with usage (the input and
  // output tokens of all calls of the step, a retry too, for the run record) and cost (micro-dollars, the same calls).
  async function ask(prompt, model, check, startedAt, call) {
    let error;
    const usage = { in: 0, out: 0 };
    let cost = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt === 2 && (cost > 0 || now() - startedAt > RETRY_WITHIN_MS)) break;
      const reply = await callModel(prompt, model, call);
      usage.in += Number(reply.usage?.input_tokens) || 0;
      usage.out += Number(reply.usage?.output_tokens) || 0;
      cost += Number(reply.cost) || 0;
      const checked = reply.error ? reply : check(reply.data);
      if (!checked.error) return { ...checked, usage, cost };
      error = checked.error;
      log(`autorun step=${prompt.step} attempt=${attempt} failed: ${error}`);
    }
    return { error, usage, cost };
  }
  const tokens = ({ in: input, out }, cost) => ({ in: input, out, usd: Number(usd(cost)) });

  async function fail(run, error) {
    await recordFailure(run, error);
    log(`autorun page=${run.pageId} run=${run.runId} failed: ${error}`);
    return { status: 'failed', pageId: run.pageId, runId: run.runId, error: `The cold read failed: ${error}` };
  }

  // The switches of the one-click run: the end date and src/guard-config.js first, then the feature flag.
  // site: { cloudId, installContext, environmentId, environmentType } from the platform's resolver context. The moment
  // of the installation is read only while new installations are paused.
  async function switchedOff(site) {
    const at = guardConfig.NEW_INSTALLS_PAUSED_FROM == null ? undefined : await installedAt();
    const reason = configRefusal(guardConfig, site.cloudId, now(), at) ?? flagRefusal(await checkFlag(site));
    if (reason) log(`guard deny reason=${reason} site=${site.cloudId}`);
    return reason;
  }
  const unavailable = { error: UNAVAILABLE, refused: 'unavailable' };

  async function cold(pageId, site = {}) {
    const startedAt = now();
    const page = await fetchPage(pageId, { withBody: true }); // as the user: fails if they cannot see the page
    if (page.error) return { error: page.error };
    if (await switchedOff(site)) return unavailable;
    const picked = await pickModel();
    if (!picked) return { error: NO_MODEL };
    const { model, price } = picked;

    const { questions } = await getQuestions(pageId);
    const { text, clipped } = clipPage(page.text);
    const linked = hasLinks(page.links);
    // The reserve of all steps is counted before the model is called; a run that does not fit is not started.
    const reserve = runReserve({ title: page.title, pageText: text, questions, price, linked });
    const held = await reserveSpend(reserve.cold + reserve.next, 'button');
    if (held.busy) return { error: 'Cold Read is busy on this site. Try again in a minute.' };
    if (held.refusal) {
      log(`guard deny reason=budget site=${site.cloudId}`);
      return { error: budgetText(held.refusal.refill), refused: 'budget' };
    }
    // What stays reserved for the later steps; in a warm read `warm` is the part of it for step 2.
    const spend = { day: held.day, reserved: reserve.next, ...(reserve.warm ? { warm: reserve.warm } : {}) };

    const run = await startRun({ pageId, title: page.title, pageVersion: page.version, questions, via: 'button', clipped, spend });
    const reply = await ask(
      coldPrompt({ title: page.title, pageText: text, questions: run.questions }),
      model,
      (data) => parseAnswers(data, run.questions.length),
      startedAt,
      { price, site: site.cloudId },
    );
    const usage = { cold: tokens(reply.usage, reply.cost) };
    if (reply.error) {
      await settleSpend(held.day, held.reserved, reply.cost); // a failed run takes no second step
      return fail({ ...run, model, usage, spend: { day: held.day, reserved: 0 } }, reply.error);
    }

    // The expected answers of the same read the reserve was counted from; the model got the question texts only.
    const saved = await recordAnswers({ ...run, model, usage }, reply, questions);
    const expected = expectedOf(saved);
    // No expected answers and no linked Jira issue or page: nothing to compare with, the run ends here.
    const ends = !expected.length && !linked;
    await settleSpend(held.day, reserve.cold + (ends ? reserve.next : 0), reply.cost);
    log(`autorun cold page=${pageId} run=${run.runId} model=${model} answered=${saved.answers.length} missing=${saved.missing.length} expected=${expected.length} linked=${linked} clipped=${clipped}`);
    const answers = saved.answers.map(({ q, answer, quote, notStated }) => ({ q, question: saved.questions[q - 1].text, answer, quote, notStated }));
    if (ends) {
      const done = await recordFindings({ ...saved, spend: { day: held.day, reserved: 0 }, warm: { at: new Date(now()).toISOString(), links: 0, sources: [] } }, []);
      log(`autorun findings page=${pageId} run=${run.runId} model=${model} nothing to compare with`);
      return { status: 'checked', pageId, runId: run.runId, model, clipped, compareWith: null, answers, missing: saved.missing, run: done };
    }
    await markPending(saved);
    return {
      status: 'answered',
      pageId,
      runId: run.runId,
      model,
      clipped,
      compareWith: expected.length ? 'expected answers' : 'warm read',
      answers,
      missing: saved.missing,
    };
  }

  async function compare(pageId, runId, site = {}) {
    const startedAt = now();
    const page = await fetchPage(pageId, { withBody: true }); // as the user; the warm read needs the text and links too
    if (page.error) return { error: page.error };
    const run = await getRun(pageId, runId);
    if (!run || run.via !== 'button') return { error: `There is no one-click cold read ${runId} of page ${pageId}. Run a new one.` };
    if (run.status === 'reading') return { error: 'The reader did not save its answers to this cold read. Start a new cold read.' };

    const owner = expectedOf(run);
    const warmStep = !owner.length && !run.warm?.answers; // step 2 of a warm read; otherwise the compare step
    const refusal = runRefusal(run, warmStep ? 'warm' : 'findings', { pageId, runId });
    if (refusal) return { error: refusal };
    if (await switchedOff(site)) return unavailable;
    const picked = await pickModel();
    if (!picked) return { error: NO_MODEL };
    const { model, price } = picked;
    const call = { price, site: site.cloudId };

    // The reserve of this step is replaced by its cost, whatever the outcome: step 2 of a warm read settles its own part
    // (spend.warm) and leaves the rest for step 3; the compare step settles all that is left. A run started before the
    // spend limit (no spend in its record) adds its cost to today.
    const day = run.spend?.day ?? spendDay(now());
    const reserved = run.spend?.reserved ?? 0;
    const settleAll = (cost) => settleSpend(day, reserved, cost);
    const withSpend = (r, left = 0) => (run.spend ? { ...r, spend: { day: run.spend.day, reserved: left } } : r);
    const finish = async (record, findings, compareWith) => {
      const saved = await recordFindings(record, findings);
      const count = (v) => saved.findings.filter((f) => f.verdict === v).length;
      log(`autorun findings page=${pageId} run=${runId} model=${model} A=${count('A')} B=${count('B')} C=${count('C')} match=${count('match')}`);
      return { status: 'checked', pageId, runId, model, compareWith, findings: { A: count('A'), B: count('B'), C: count('C'), match: count('match') }, run: saved };
    };
    // Each step is taken once (a mark in the store), after all its reads and before anything is called, counted or
    // written: a second call of the same step, at the same time or later, gets STEP_TAKEN.
    const taken = async () => !(await claimStep(pageId, runId, warmStep ? 'warm' : 'findings'));

    // A run goes on only as its reserve was counted: the same UTC day, page version and model.
    const stop = continueRefusal(run, { pageVersion: page.version, model, now: now() });
    if (stop) {
      if (await taken()) return { error: STEP_TAKEN };
      await settleAll(0);
      return fail(withSpend({ ...run }), stop);
    }

    if (warmStep) {
      // At most WARM_SOURCES linked pages and issues, each cut to WARM_SOURCE_CHARS characters.
      const links = page.links ?? { pageIds: [], pageTitles: [], issueKeys: [] };
      const found = await findRelated({ pageId, spaceId: page.spaceId, links }, { sources: WARM_SOURCES, chars: WARM_SOURCE_CHARS });
      const linkCount = links.pageIds.length + links.pageTitles.length + links.issueKeys.length;
      log(`autorun warm page=${pageId} run=${runId} links=${linkCount} sources=${found.sources.map((s) => s.issueKey ?? s.pageId).join(',') || 'none'}`);
      if (await taken()) return { error: STEP_TAKEN };
      if (found.sources.length === 0) {
        // The linked issues and pages cannot be read: nothing to compare with, the run ends without findings.
        await settleAll(0);
        return finish(withSpend({ ...run, warm: { at: new Date(now()).toISOString(), links: linkCount, sources: [] } }), [], null);
      }
      const part = run.spend ? (run.spend.warm ?? reserved) : 0;
      const reply = await ask(
        warmAnswersPrompt({ title: run.title, pageText: clipPage(page.text).text, questions: run.questions, related: found.related, relatedIssues: found.relatedIssues }),
        model,
        (data) => parseWarmAnswers(data, run.questions.length, found.sources),
        startedAt,
        call,
      );
      const usage = { ...run.usage, warm: tokens(reply.usage, reply.cost) };
      if (reply.error) {
        await settleAll(reply.cost); // a failed run takes no step 3: what was left for it is freed too
        return fail(withSpend({ ...run, model, usage }), reply.error);
      }
      await settleSpend(day, part, reply.cost);
      // The sources an answer rests on are marked used: the panel names only those.
      await recordWarm(withSpend({ ...run, model, usage }, reserved - part), { links: linkCount, sources: markUsed(found.sources, reply.answers), answers: reply.answers });
      log(`autorun warm answers page=${pageId} run=${runId} model=${model} answered=${reply.answers.length} used=${reply.answers.filter((x) => x.sources.length).length}`);
      return { status: 'warmed', pageId, runId, model, compareWith: 'warm read' };
    }

    if (!owner.length) {
      // Step 3 of a warm read: CONFLICT_CALLS conflict checks with the same request, side by side; a question is a
      // conflict by two votes of three, and only with both quotes found (voteConflicts). A failed call is no vote; with
      // fewer than two replies the step fails. The sources are read again as the user: their text is not stored.
      const links = page.links ?? { pageIds: [], pageTitles: [], issueKeys: [] };
      const found = await findRelated({ pageId, spaceId: page.spaceId, links }, { sources: WARM_SOURCES, chars: WARM_SOURCE_CHARS });
      if (await taken()) return { error: STEP_TAKEN };
      const pageText = clipPage(page.text).text;
      const material = { run, pageText, related: found.related, relatedIssues: found.relatedIssues };
      const prompt = conflictPrompt(material);
      const replies = await Promise.all(
        Array.from({ length: CONFLICT_CALLS }, () => ask(prompt, model, (data) => parseConflicts(data, run.questions.length), startedAt, call)),
      );
      const spent = replies.reduce((sum, r) => ({ in: sum.in + r.usage.in, out: sum.out + r.usage.out }), { in: 0, out: 0 });
      const cost = replies.reduce((sum, r) => sum + r.cost, 0);
      const usage = { ...run.usage, conflict: tokens(spent, cost) };
      await settleAll(cost);
      if (replies.filter((r) => !r.error).length < 2) return fail(withSpend({ ...run, model, usage }), replies.find((r) => r.error).error);
      const outcomes = replies.map((r) => (r.error ? [] : r.outcomes));
      const { findings, dropped } = voteConflicts(outcomes, material);
      const votes = run.questions.map((_, i) => `${i + 1}:${outcomes.filter((o) => o.find((x) => x.q === i + 1)?.outcome === 'conflict').length}`).join(',');
      log(`autorun conflict page=${pageId} run=${runId} model=${model} votes=${votes} replies=${outcomes.filter((o) => o.length).length}`);
      // The log line of a dropped conflict holds no page text: which quote of the first vote was not found (and no
      // vote nor the quotes of the two answers gave a found pair).
      for (const d of dropped) log(`autorun conflict page=${pageId} run=${runId} q=${d.q} dropped: page quote ${d.page ? 'found' : 'not found'}, source quote ${d.source ? 'found' : 'not found'}; no other pair of quotes found`);
      // The store keeps the full record; the panel gets it as this person may see it: the linked sources of the record
      // that this call could not read are hidden (runForViewer).
      const done = await finish(withSpend({ ...run, model, usage }), findings, 'warm read');
      const hidden = (done.run.warm?.sources ?? []).filter((s) => !found.sources.some((f) => f.pageId === s.pageId && f.issueKey === s.issueKey));
      return { ...done, run: runForViewer(done.run, hidden) };
    }

    // The compare step with the owner's expected answers. Up to five questions: one call; more: parts of up to five
    // called side by side, findings joined by question.
    if (await taken()) return { error: STEP_TAKEN };
    const replies = await Promise.all(compareParts(owner).map((part) => {
      const allowed = new Set(part.map((e) => e.q));
      return ask(comparePrompt({ run, expected: part }), model, (data) => {
        // In the development environment only: the elements the model wrote out, to see why it gave a verdict.
        // They hold page text, so they never go to the log in production and never into the run record.
        // A reply whose findings are not an array is logged as it came and left to parseFindings (no crash here).
        if (elementsLogged()) {
          const found = data?.findings;
          const rows = Array.isArray(found)
            ? found.map((f) => [f?.q, f?.expected_elements, f?.saved_elements, f?.verdict])
            : { findingsType: typeof found, findings: found };
          log(`autorun elements run=${run.runId} ${JSON.stringify(rows)}`.slice(0, 4000));
        }
        return parseFindings(data, allowed);
      }, startedAt, call);
    }));
    const spent = replies.reduce((sum, r) => ({ in: sum.in + r.usage.in, out: sum.out + r.usage.out }), { in: 0, out: 0 });
    const cost = replies.reduce((sum, r) => sum + r.cost, 0);
    const usage = { ...run.usage, compare: tokens(spent, cost) };
    await settleAll(cost);
    const failed = replies.find((r) => r.error);
    if (failed) return fail(withSpend({ ...run, model, usage }), failed.error);
    const findings = replies.flatMap((r) => r.findings).sort((a, b) => a.q - b.q);
    return finish(withSpend({ ...run, model, usage }), findings, 'expected answers');
  }

  return { cold, compare };
}
