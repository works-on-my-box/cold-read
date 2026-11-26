// A thin wrapper over Forge LLMs (@forge/llm) for the one-click run: one chat() call with a forced tool,
// temperature 0 (or none, for a model that refuses it) and at most MAX_OUTPUT_TOKENS of output (chatRequest in logic.js).
// The model list (with the prices) is asked once a UTC day and kept in KVS.
import { chat, list } from '@forge/llm';
import { kvs } from '@forge/kvs';
import { MODEL_PREFERENCE, chooseModel, chatRequest, readReply, llmErrorText, temperatureRefused, priceOf, callCost, requestCost, usd } from './logic';

const MODELS_KEY = 'llm:models';

// The model for a run, { model, price }: the first of MODEL_PREFERENCE that the site lists as active, or null.
// price: USD per million input and output tokens, from the list or from the table in logic.js.
export async function pickModel(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  let listed = await kvs.get(MODELS_KEY);
  if (listed?.day !== day) {
    try {
      const res = await list();
      listed = { day, models: (res?.models ?? []).map(({ model, status, pricing }) => ({ model, status, ...(pricing ? { pricing } : {}) })) };
      await kvs.set(MODELS_KEY, listed);
    } catch (err) {
      // Keep the last list if there is one; without any list the first model of the preference is tried.
      console.log(`llm list failed: ${err?.name} status=${err?.status} code=${err?.code}`);
    }
  }
  const model = chooseModel(MODEL_PREFERENCE, listed);
  return model ? { model, price: priceOf(model, listed) } : null;
}

// prompt: { step, messages, tool } from coldPrompt, comparePrompt or warmPrompt; price from pickModel; site: the cloudId.
// Returns { data, ms, usage, cost } or { error, ms, cost: 0 } with a short line for the panel; cost in micro-dollars.
// A call refused for its temperature spends no tokens: only the call made again without it counts. A reply without
// usage costs the upper estimate of its request (requestCost), so no reply is counted at 0.
export async function callModel(prompt, model, { price, site } = {}) {
  const t0 = Date.now();
  const request = chatRequest(prompt, model);
  try {
    let res;
    try {
      res = await chat(request);
    } catch (err) {
      if (!('temperature' in request) || !temperatureRefused(err)) throw err;
      console.log(`llm step=${prompt.step} model=${model} temperature refused: ${String(err?.message).slice(0, 200)}`);
      const { temperature, ...withoutTemperature } = request;
      res = await chat(withoutTemperature);
    }
    const ms = Date.now() - t0;
    const usage = res?.usage ?? {};
    const rate = price ?? priceOf(model);
    const missing = !(Number(usage.input_tokens) > 0);
    const cost = missing ? requestCost(request, rate) : callCost(usage, rate);
    console.log(`llm step=${prompt.step} model=${model} ms=${ms} in=${usage.input_tokens} out=${usage.output_tokens} cost_usd=${usd(cost)}${missing ? ' usage=missing' : ''} finish=${res?.choices?.[0]?.finish_reason} site=${site}`);
    return { ...readReply(res), ms, usage, cost };
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`llm step=${prompt.step} model=${model} ms=${ms} error=${err?.name} status=${err?.status} code=${err?.code} message=${String(err?.message).slice(0, 200)} cost_usd=${usd(0)} site=${site}`);
    return { error: llmErrorText(err), ms, cost: 0 };
  }
}
