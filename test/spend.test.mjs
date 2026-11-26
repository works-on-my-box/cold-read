import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSpend, BUSY } from '../src/spend.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 20, 3, 0);

// An in-memory Key-Value Store that counts its calls: get, set (keyPolicy FAIL_IF_EXISTS), delete, batchGet (at most
// 25 keys, as KVS). Each call waits a tick, so calls going at the same time interleave.
function fakeKvs() {
  const data = new Map();
  const ops = { get: 0, set: 0, delete: 0, batchGet: 0, keysRead: [] };
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    data,
    ops,
    async get(key) {
      ops.get += 1;
      ops.keysRead.push(key);
      await tick();
      return copy(data.get(key));
    },
    async set(key, value, options) {
      ops.set += 1;
      await tick();
      if (options?.keyPolicy === 'FAIL_IF_EXISTS' && data.has(key)) {
        // what the Forge store answers (seen on a live installation)
        throw Object.assign(new Error('Provided key already exists and cannot be overwritten'), { code: 'KEY_CONFLICT', name: 'ForgeKvsError' });
      }
      data.set(key, copy(value));
    },
    async delete(key) {
      ops.delete += 1;
      await tick();
      data.delete(key);
    },
    async batchGet(items) {
      ops.batchGet += 1;
      assert.ok(items.length <= 25, 'a KVS batch holds at most 25 keys');
      ops.keysRead.push(...items.map((i) => i.key));
      await tick();
      return { successfulKeys: items.filter(({ key }) => data.has(key)).map(({ key }) => ({ key, value: copy(data.get(key)) })), failedKeys: [] };
    },
  };
}

const setup = (t = T0, kvs = fakeKvs()) => {
  const clock = { t };
  const logs = [];
  const spend = makeSpend(kvs, { now: () => clock.t, sleep: () => new Promise((r) => setTimeout(r, 1)), log: (l) => logs.push(l) });
  return { kvs, clock, logs, spend };
};

test('the moment of installation: the install event, or the first call when the event did not come; the first wins', async () => {
  const a = setup();
  await a.spend.recordInstall(T0 - HOUR);
  await a.spend.recordInstall(T0); // another event later (another product of the same app) changes nothing
  assert.deepEqual(a.kvs.data.get('spend:install').at, new Date(T0 - HOUR).toISOString());
  assert.equal(a.kvs.data.get('spend:install').from, 'install event');
  assert.equal((await a.spend.base()).installedAt, T0 - HOUR);

  const b = setup();
  const base = await b.spend.base();
  assert.equal(base.installedAt, T0);
  assert.equal(b.kvs.data.get('spend:install').from, 'first call');
  await b.spend.recordInstall(T0 + HOUR); // the event came after the first call: the first call stays
  assert.equal((await b.spend.base()).installedAt, T0);
});

test('a fresh installation can reserve $0.60 at once, $0.70 after an hour, the day limit after four hours', async () => {
  const { spend, clock } = setup();
  assert.deepEqual(await spend.reserve(600001), { refusal: { reason: 'budget', refill: { hours: 1, runs: 2 } } });
  assert.deepEqual(await spend.reserve(600000), { day: '2026-11-20', reserved: 600000 });
  assert.equal((await spend.reserve(1)).refusal.reason, 'budget');
  clock.t = T0 + HOUR;
  assert.deepEqual(await spend.reserve(100000), { day: '2026-11-20', reserved: 100000 });
  assert.equal((await spend.reserve(1)).refusal.reason, 'budget');
  clock.t = T0 + 4 * HOUR;
  assert.ok((await spend.reserve(300000)).reserved, 'up to $1.00 by four hours');
  clock.t = T0 + 9 * HOUR;
  assert.equal((await spend.reserve(1)).refusal.reason, 'budget', 'and no more that UTC day');
});

test('settle replaces a reserve by what was spent; a step that cost more than its estimate is counted in full', async () => {
  const { spend, kvs } = setup();
  const held = await spend.reserve(100000);
  await spend.settle(held.day, 60000, 20000);
  assert.equal(kvs.data.get('spend:2026-11-20').spent, 60000);
  await spend.settle(held.day, 40000, 45000);
  assert.equal(kvs.data.get('spend:2026-11-20').spent, 65000);
  await spend.settle(held.day, 0, 0);
  assert.equal(kvs.data.get('spend:2026-11-20').spent, 65000);
});

test('the 30-day sum comes from the 29 days before, read once a UTC day in two batches; the old run counts are not read', async () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-10-01T00:00:00.000Z', from: 'install event' });
  for (const [day, spent] of [['2026-11-19', 900000], ['2026-11-05', 900000], ['2026-10-22', 900000], ['2026-10-21', 900000]]) kvs.data.set(`spend:${day}`, { spent, events: 0 });
  kvs.data.set('budget:2026-11-20', 9);
  const { spend, clock } = setup(T0, kvs);
  // 2026-10-21 is 30 days before today: outside. $3.00 - $2.70 = $0.30 left.
  assert.equal(await spend.left(), 2);
  assert.equal(kvs.ops.batchGet, 2);
  assert.deepEqual(kvs.data.get('spend:install').past.days.filter(Boolean), [900000, 900000, 900000]);
  kvs.ops.get = 0;
  kvs.ops.keysRead = [];
  assert.equal(await spend.left(), 2);
  assert.equal(kvs.ops.batchGet, 2, 'the same day: no new batch');
  assert.deepEqual(kvs.ops.keysRead, ['spend:install', 'spend:2026-11-20'], 'the panel reads two keys');
  assert.ok(!kvs.ops.keysRead.some((k) => k.startsWith('budget:')));
  kvs.ops.keysRead = [];
  await spend.reserve(10000);
  assert.deepEqual(kvs.ops.keysRead, ['spend:install', 'spend:2026-11-20'], 'a reserve reads two keys');
  kvs.ops.keysRead = [];
  await spend.settle('2026-11-20', 10000, 5000);
  assert.deepEqual(kvs.ops.keysRead, ['spend:2026-11-20'], 'a settle reads one');
  clock.t = T0 + 24 * HOUR;
  await spend.left();
  assert.equal(kvs.ops.batchGet, 4, 'the next UTC day: the 29 days are read again');
});

test('events (page changes): the same money, at most five runs a UTC day', async () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-10-01T00:00:00.000Z', from: 'install event' });
  const { spend } = setup(T0, kvs);
  for (let i = 0; i < 5; i += 1) assert.ok((await spend.reserve(10000, 'event')).reserved, `event run ${i + 1}`);
  assert.equal((await spend.reserve(10000, 'event')).refusal.reason, 'budget');
  assert.ok((await spend.reserve(10000, 'button')).reserved, 'the button still has money');
  assert.deepEqual(kvs.data.get('spend:2026-11-20'), { spent: 60000, events: 5 });
});

test('reserves at the same time: the lock lets each read the total the one before wrote', async () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-10-01T00:00:00.000Z', from: 'install event' });
  const { spend, logs } = setup(T0, kvs);
  const results = await Promise.all(Array.from({ length: 27 }, () => spend.reserve(40000)));
  assert.equal(results.filter((r) => r.reserved).length, 25, '$1.00 holds 25 reserves of $0.04');
  assert.equal(kvs.data.get('spend:2026-11-20').spent, 1000000);
  assert.equal(kvs.data.has('spend:lock'), false);
  assert.ok(logs.includes('spend lock held, waiting: KEY_CONFLICT'), 'a run that waited says so, with the code of the store');
  assert.equal(logs.filter((l) => l.startsWith('spend lock held')).length, 26, 'once per waiting run');
});

test('a lock left by a holder that broke off is taken over; a lock that stays held gives BUSY', async () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-10-01T00:00:00.000Z', from: 'install event' });
  kvs.data.set('spend:lock', { until: T0 - 1 });
  const { spend, logs } = setup(T0, kvs);
  assert.ok((await spend.reserve(10000)).reserved);
  kvs.data.set('spend:lock', { until: T0 + 60000 });
  assert.equal(await spend.reserve(10000), BUSY);
  assert.equal(kvs.data.get('spend:2026-11-20').spent, 10000, 'nothing reserved while busy');
  assert.ok(logs.includes('spend lock not taken: KEY_CONFLICT'));
});

test('a lock freed between a refused write and the read, more than three times while one run waits: that run still waits for the lock, both reserves are counted', async () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-10-01T00:00:00.000Z', from: 'install event' });
  const day = 'spend:2026-11-20';
  const plainGet = kvs.get;
  const plainSet = kvs.set;
  let gone = 0; // times the waiting run read "no lock" after its write of the lock was refused
  let reads = 0;
  let inside = 0;
  let most = 0;
  kvs.get = async (key) => {
    if (key === 'spend:lock') {
      await plainGet(key);
      gone += 1;
      return undefined;
    }
    if (key === day) {
      reads += 1;
      inside += 1;
      most = Math.max(most, inside);
      // the first reserve stays inside until the other run has read "no lock" more than three times
      if (reads === 1) while (gone <= 3 && reads < 2) await new Promise((r) => setTimeout(r, 0));
    }
    return plainGet(key);
  };
  kvs.set = async (key, value, options) => {
    await plainSet(key, value, options);
    if (key === day) inside -= 1;
  };
  const { spend, logs } = setup(T0, kvs);
  const results = await Promise.all([spend.reserve(10000), spend.reserve(10000)]);
  assert.equal(most, 1, 'the second reserve reads the day only after the first has written it');
  assert.equal(kvs.data.get(day).spent, 20000, 'both reserves counted');
  assert.equal(results.filter((r) => r.reserved).length, 2);
  assert.ok(gone > 3, 'the waiting run read "no lock" more than three times');
  assert.equal(kvs.data.has('spend:lock'), false);
  assert.ok(logs.includes('spend lock held, waiting: KEY_CONFLICT'));
  assert.ok(!logs.some((l) => l.startsWith('spend lock not taken')));
});

test('a store that refuses every write of the lock: the reserve gives BUSY and the day is not written; a settle leaves the reserve counted', async () => {
  const kvs = fakeKvs();
  kvs.data.set('spend:install', { at: '2026-10-01T00:00:00.000Z', from: 'install event' });
  const plainSet = kvs.set;
  kvs.set = async (key, value, options) => {
    if (options?.keyPolicy === 'FAIL_IF_EXISTS') throw Object.assign(new Error('Bad request'), { code: 'INVALID_OPTION' });
    return plainSet(key, value, options);
  };
  const { spend, logs } = setup(T0, kvs);
  assert.equal(await spend.reserve(10000), BUSY);
  assert.equal(kvs.data.has('spend:2026-11-20'), false, 'the day is not written');
  assert.ok(logs.includes('spend lock not taken: INVALID_OPTION'));
  kvs.data.set('spend:2026-11-20', { spent: 10000, events: 0 }); // a reserve counted before
  await spend.settle('2026-11-20', 10000, 0);
  assert.deepEqual(kvs.data.get('spend:2026-11-20'), { spent: 10000, events: 0 }, 'the reserve stays counted');
  assert.ok(logs.includes('spend settle busy day=2026-11-20 reserved=10000 spent=0'));
  assert.equal(logs.filter((l) => l.startsWith('spend lock not taken')).length, 2, 'once per call');
});
