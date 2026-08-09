import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalJsonActivationCodec,
  decodeActivationMarker,
  encodeActivationMarker,
} from '../../server/src/lib/inbox/activation.js';
import { InboxRefCodec } from '../../server/src/lib/inbox/identity.js';
import {
  InboxStateStore,
  InboxStateStoreError,
  projectDecisionState,
} from '../../server/src/lib/inbox/state-store.js';

const CHANNEL = 'telegram';
const ACCOUNT = 'acc_state_store_000001';

const sequenceCodec = {
  encode(marker) { return String(marker.sequence); },
  decode(persisted) {
    if (typeof persisted !== 'string' || !/^(0|[1-9]\d*)$/.test(persisted)) {
      throw new Error('sequence marker не canonical');
    }
    return { sequence: Number(persisted) };
  },
};

async function fixture(t, { maxEpochs, prefix = 'inbox-state-' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const refCodec = new InboxRefCodec({ channel: CHANNEL, accountRef: ACCOUNT });
  let decisionNumber = 0;
  const file = path.join(dir, 'inbox-state.json');
  const store = new InboxStateStore({
    file,
    channel: CHANNEL,
    accountRef: ACCOUNT,
    refCodec,
    activationCodec: sequenceCodec,
    maxEpochs,
    createDecisionId: () => `decision_${String(++decisionNumber).padStart(16, '0')}`,
  });
  return { dir, file, store, refCodec };
}

async function activate(store, sequence = 1, nowMs = 100) {
  return store.activate({
    expectedActivationVersion: 0,
    nowMs,
    createActivationMarker: async () => ({ sequence }),
  });
}

const decisionInput = (codec, over = {}) => ({
  activationEpoch: 1,
  originItemRef: codec.item('bundle-1'),
  messageRefs: [codec.message('source', '1')],
  scopeRef: codec.scope('policy'),
  status: 'skipped',
  taskId: null,
  taskUrl: '',
  by: 'human',
  note: '',
  decidedAtMs: 200,
  ...over,
});

test('отсутствующий файл означает never_activated и простой read ничего не создаёт', async (t) => {
  const { dir, store } = await fixture(t);
  assert.equal(await store.read(), null);
  assert.deepEqual(await store.summary(), {
    participation: 'never_activated',
    activationVersion: 0,
    currentEpoch: null,
    startedAtMs: null,
    endedAtMs: null,
    endReason: null,
  });
  assert.deepEqual(await readdir(dir), []);
});

test('parallel activate создаёт marker один раз; activate/deactivate идемпотентны и CAS-защищены', async (t) => {
  const { store } = await fixture(t);
  let markerCalls = 0;
  const request = () => store.activate({
    expectedActivationVersion: 0,
    nowMs: 100,
    createActivationMarker: async () => ({ sequence: ++markerCalls }),
  });
  const [first, second] = await Promise.all([request(), request()]);
  assert.deepEqual(first, second);
  assert.equal(markerCalls, 1);
  assert.equal(first.activationVersion, 1);

  let endCalls = 0;
  const close = () => store.deactivate({
    expectedActivationVersion: 1,
    nowMs: 200,
    endReason: 'manual_pause',
    createActivationMarker: async () => ({ sequence: 10 + ++endCalls }),
  });
  const closed = await close();
  assert.equal(closed.participation, 'deactivated');
  assert.equal((await close()).activationVersion, 2);
  assert.equal(endCalls, 1);

  await assert.rejects(store.activate({
    expectedActivationVersion: 0,
    nowMs: 300,
    createActivationMarker: async () => ({ sequence: 20 }),
  }), (err) => err instanceof InboxStateStoreError && err.code === 'stale_activation');

  const reopened = await store.activate({
    expectedActivationVersion: 2,
    nowMs: 300,
    createActivationMarker: async () => ({ sequence: 20 }),
  });
  assert.equal(reopened.activationVersion, 3);
  assert.deepEqual(await store.activationWindows(), [
    { epoch: 1, startMarker: { sequence: 1 }, endMarker: { sequence: 11 } },
    { epoch: 2, startMarker: { sequence: 20 }, endMarker: null },
  ]);
});

test('marker codec требует canonical round-trip и лимит 4096 bytes', () => {
  assert.deepEqual(decodeActivationMarker(
    sequenceCodec,
    encodeActivationMarker(sequenceCodec, { sequence: 42 }),
  ), { sequence: 42 });
  assert.throws(() => decodeActivationMarker(sequenceCodec, '042'), /отклонил marker|alias/);
  assert.throws(() => encodeActivationMarker(canonicalJsonActivationCodec, {
    cursor: 'x'.repeat(5000),
  }), /4096/);
});

test('decision refs сортируются, assignments не пересекаются, closed epoch остаётся решаемой', async (t) => {
  const { store, refCodec } = await fixture(t);
  await activate(store);
  await store.deactivate({
    expectedActivationVersion: 1,
    nowMs: 150,
    createActivationMarker: async () => ({ sequence: 2 }),
  });
  const refs = [
    refCodec.message('source', 'z'),
    refCodec.message('source', 'a'),
  ];
  await assert.rejects(store.decide(decisionInput(refCodec, {
    originItemRef: refCodec.item('auto-dismiss'),
    messageRefs: [refCodec.message('source', 'auto-dismiss')],
    by: 'auto',
    requireActive: true,
  })), (err) => err.code === 'channel_deactivated');
  const decision = await store.decide(decisionInput(refCodec, { messageRefs: refs }));
  assert.deepEqual(decision.messageRefs, [...refs].sort());
  assert.equal(decision.version, 1);
  assert.equal(decision.activationEpoch, 1);

  await assert.rejects(store.decide(decisionInput(refCodec, {
    originItemRef: refCodec.item('bundle-2'),
    messageRefs: [refs[0]],
    decidedAtMs: 201,
  })), (err) => err.code === 'stale_item');
  await assert.rejects(store.decide(decisionInput(refCodec, {
    messageRefs: [refs[0], refs[0]],
  })), (err) => err.code === 'invalid_selection');
});

test('residual reset сохраняет id, увеличивает version и делает CAS; task reset запрещён', async (t) => {
  const { store, refCodec } = await fixture(t);
  await activate(store);
  const firstRef = refCodec.message('source', '1');
  const secondRef = refCodec.message('source', '2');
  const skipped = await store.decide(decisionInput(refCodec, {
    messageRefs: [firstRef, secondRef],
  }));
  const residual = await store.reset({
    decisionId: skipped.decisionId,
    expectedVersion: 1,
    messageRefs: [firstRef],
    nowMs: 300,
  });
  assert.equal(residual.decisionId, skipped.decisionId);
  assert.equal(residual.version, 2);
  assert.deepEqual(residual.messageRefs, [secondRef]);

  await assert.rejects(store.reset({
    decisionId: skipped.decisionId,
    expectedVersion: 1,
    messageRefs: [secondRef],
    nowMs: 301,
  }), (err) => err.code === 'stale_decision');
  assert.equal(await store.reset({
    decisionId: skipped.decisionId,
    expectedVersion: 2,
    messageRefs: [secondRef],
    nowMs: 302,
  }), null);

  const taskDecision = await store.decide(decisionInput(refCodec, {
    messageRefs: [refCodec.message('source', 'task')],
    status: 'task',
    taskId: '123',
    taskUrl: 'https://b24.example/task/123',
    decidedAtMs: 400,
  }));
  await assert.rejects(store.reset({
    decisionId: taskDecision.decisionId,
    expectedVersion: 1,
    messageRefs: taskDecision.messageRefs,
    nowMs: 401,
  }), (err) => err.code === 'task_reset_forbidden');
});

test('split/merge projection даёт new, одно решение или mixed без silent coverage', async (t) => {
  const { store, refCodec } = await fixture(t);
  await activate(store);
  const a = refCodec.message('source', 'a');
  const b = refCodec.message('source', 'b');
  const c = refCodec.message('source', 'c');
  const decision = await store.decide(decisionInput(refCodec, { messageRefs: [a, b] }));
  const decisions = (await store.read()).decisions;

  assert.equal(projectDecisionState([c], decisions).status, 'new');
  assert.equal(projectDecisionState([a], decisions).status, 'skipped');
  assert.equal(projectDecisionState([a, b], decisions).decision.decisionId, decision.decisionId);
  assert.equal(projectDecisionState([a, c], decisions).status, 'mixed');
});

test('100 parallel decisions проходят единую queue без lost update и unsafe pruning', async (t) => {
  const { dir, store, refCodec } = await fixture(t, { prefix: 'inbox-state-many-' });
  await activate(store);
  await Promise.all(Array.from({ length: 100 }, (_, i) => store.decide(decisionInput(refCodec, {
    originItemRef: refCodec.item(`bundle-${i}`),
    messageRefs: [refCodec.message('source', String(i))],
    decidedAtMs: 1000 + i,
  }))));
  const state = await store.read();
  assert.equal(state.decisions.length, 100);
  assert.equal(new Set(state.decisions.map((decision) => decision.decisionId)).size, 100);
  assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false);
});

test('unknown schema keys, owner mismatch, marker aliases и overlap в persisted file fail closed', async (t) => {
  const { file, store, refCodec } = await fixture(t);
  await activate(store);
  await store.decide(decisionInput(refCodec));
  const valid = JSON.parse(await readFile(file, 'utf8'));

  await writeFile(file, `${JSON.stringify({ ...valid, surprise: true })}\n`);
  await assert.rejects(store.read(), (err) => err.code === 'invalid_state');

  await writeFile(file, `${JSON.stringify({ ...valid, accountRef: 'acc_state_store_other01' })}\n`);
  await assert.rejects(store.read(), (err) => err.code === 'account_changed');

  const alias = structuredClone(valid);
  alias.activation.epochs[0].startMarker = '01';
  await writeFile(file, `${JSON.stringify(alias)}\n`);
  await assert.rejects(store.read(), (err) => err.code === 'invalid_activation_marker');

  const overlap = structuredClone(valid);
  overlap.decisions.push({
    ...overlap.decisions[0],
    decisionId: 'decision_overlap_00000001',
  });
  await writeFile(file, `${JSON.stringify(overlap)}\n`);
  await assert.rejects(store.read(), (err) => err.code === 'invalid_state');
});
