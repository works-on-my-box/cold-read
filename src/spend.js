// The spend counters of the one-click run, in the Key-Value Store of the installation (micro-dollars; the limits are
// in src/logic.js). No key holds anything about a person.
//   spend:install        { at, from, past } - when the app was installed (from: 'install event', or 'first call' when
//                        the event was not there), and past: { day, days } - what was spent on each of the 29 UTC days
//                        before `day`, yesterday first, read once a day for the 30-day limit
//   spend:<YYYY-MM-DD>   { spent, events } - spent and reserved that UTC day; runs started by a page event
//   spend:lock           { until } - held for a moment while a day is read and written (KVS has no increment)
// kvs: the kvs of @forge/kvs, or a fake in the tests. No Forge imports here, so the tests load this file.
import { pastDays, spendDay, spendRefusal, runsLeft } from './logic.js';

const INSTALL_KEY = 'spend:install';
const LOCK_KEY = 'spend:lock';
const LOCK_HOLD_MS = 5000; // a holder that broke off frees the lock after this
const LOCK_WAIT_MS = 50;
const LOCK_TRIES = 40;
const BATCH_KEYS = 25; // the most keys of one KVS batch
const dayKey = (day) => `spend:${day}`;
export const BUSY = { busy: true };

export function makeSpend(kvs, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  // The install event: the first moment wins (the first call of the panel may have come before it).
  async function recordInstall(at = now()) {
    try {
      await kvs.set(INSTALL_KEY, { at: new Date(at).toISOString(), from: 'install event' }, { keyPolicy: 'FAIL_IF_EXISTS' });
    } catch {
      // already recorded
    }
  }

  // { day, installedAt, past }: one read; the first call of an installation without the event records the moment,
  // and once a UTC day the 29 days before are read again (two batches).
  async function base() {
    const t = now();
    const day = spendDay(t);
    let install = await kvs.get(INSTALL_KEY);
    if (!install?.at) {
      const first = { at: new Date(t).toISOString(), from: 'first call' };
      try {
        await kvs.set(INSTALL_KEY, first, { keyPolicy: 'FAIL_IF_EXISTS' });
        install = first;
      } catch {
        install = (await kvs.get(INSTALL_KEY)) ?? first;
      }
    }
    if (install.past?.day !== day) {
      const keys = pastDays(t).map(dayKey);
      const values = new Map();
      for (let i = 0; i < keys.length; i += BATCH_KEYS) {
        const { successfulKeys = [] } = await kvs.batchGet(keys.slice(i, i + BATCH_KEYS).map((key) => ({ key })));
        successfulKeys.forEach(({ key, value }) => values.set(key, value));
      }
      install = { ...install, past: { day, days: keys.map((k) => Number(values.get(k)?.spent) || 0) } };
      await kvs.set(INSTALL_KEY, install);
    }
    return { day, installedAt: Date.parse(install.at), past: install.past.days };
  }

  const readDay = async (day) => {
    const v = await kvs.get(dayKey(day));
    return { spent: Number(v?.spent) || 0, events: Number(v?.events) || 0 };
  };

  // Runs fn while this installation's lock is held, so two runs never read the same day total and write over each
  // other. fn runs only after this call has written the lock: a write the store refuses is tried again after a short
  // wait, whether another run still holds the lock or has freed it since; a lock left by a holder that broke off is
  // taken over. Returns what fn returns, or BUSY if the lock is not taken (the log says so, with the store's code).
  async function held(fn) {
    let waited = false;
    let code = 'error';
    for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
      try {
        await kvs.set(LOCK_KEY, { until: now() + LOCK_HOLD_MS }, { keyPolicy: 'FAIL_IF_EXISTS' });
      } catch (err) {
        code = err?.code ?? err?.name ?? 'error';
        const lock = await kvs.get(LOCK_KEY);
        if (lock && !(Number(lock.until) > now())) {
          await kvs.delete(LOCK_KEY); // left by a holder that broke off
        } else {
          // Another run holds it, or freed it after the store refused the write. Logged once, with the store's code.
          if (!waited) log(`spend lock held, waiting: ${code}`);
          waited = true;
          await sleep(LOCK_WAIT_MS);
        }
        continue;
      }
      try {
        return await fn();
      } finally {
        await kvs.delete(LOCK_KEY).catch((err) => log(`spend lock not freed: ${err?.code ?? err?.name ?? 'error'}`));
      }
    }
    log(`spend lock not taken: ${code}`);
    return BUSY;
  }

  // Counts the reserve `need` of a run that may start now: { day, reserved }, { refusal } (spendRefusal in logic.js)
  // or BUSY. source: 'button' or 'event'.
  async function reserve(need, source = 'button') {
    const b = await base();
    return held(async () => {
      const today = await readDay(b.day);
      const refusal = spendRefusal({ ...b, today: today.spent, events: today.events }, need, now(), source);
      if (refusal) return { refusal };
      await kvs.set(dayKey(b.day), { spent: today.spent + need, events: today.events + (source === 'event' ? 1 : 0) });
      return { day: b.day, reserved: need };
    });
  }

  // Replaces `reserved`, counted on `day`, by `spent`, what the calls of the step cost. If the lock is not taken the
  // reserve stays counted (the log says so).
  async function settle(day, reserved, spent) {
    if (reserved === spent) return;
    const done = await held(async () => {
      const v = await readDay(day);
      await kvs.set(dayKey(day), { spent: Math.max(0, v.spent - reserved + spent), events: v.events });
    });
    if (done === BUSY) log(`spend settle busy day=${day} reserved=${reserved} spent=${spent}`);
  }

  // Usual runs left now, for the panel.
  async function left() {
    const b = await base();
    const today = await readDay(b.day);
    return runsLeft({ ...b, today: today.spent }, now());
  }

  return { recordInstall, base, reserve, settle, left };
}
