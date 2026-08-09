import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  InboxCoordinator,
  InboxCoordinatorError,
  toPublicInboxItem,
} from '../../server/src/lib/inbox/coordinator.js';
import { canonicalJsonActivationCodec } from '../../server/src/lib/inbox/activation.js';
import { InboxRefCodec } from '../../server/src/lib/inbox/identity.js';
import { InboxStateStore } from '../../server/src/lib/inbox/state-store.js';

const T0 = 1_786_172_400;

const message = ({ channel, accountRef, sourceId = 'source:1', id = '1', over = {} }) => ({
  schema: 1,
  channel,
  accountRef,
  source: { id: sourceId, title: 'Обращения', threadId: null },
  id,
  parentId: null,
  groupId: null,
  occurredAt: T0,
  editedAt: null,
  author: { id: 'author:1', name: 'Имя' },
  text: 'Баг / Не работает кнопка',
  attachments: [{
    ref: `opaque-ref-${channel}-${id}`,
    dedupeKey: `opaque-key-${channel}-${id}`,
    kind: 'image',
    displayLabel: 'скриншот',
    name: 'ошибка.png',
    size: 42,
  }],
  service: false,
  ...over,
});

const policy = (scopeId = 'scope:1', over = {}) => ({
  scopeId,
  project: 'cockpit',
  kind: 'bug',
  b24: { groupId: 10, responsibleId: 20, priority: 2 },
  autoTask: { enabled: false, minConfidence: 0.8, maxPerDay: 5 },
  ...over,
});

async function stateFixture(t, channel, accountRef, { activated = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `inbox-coordinator-${channel}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const refCodec = new InboxRefCodec({ channel, accountRef });
  const store = new InboxStateStore({
    file: path.join(dir, 'inbox-state.json'),
    channel,
    accountRef,
    refCodec,
    activationCodec: canonicalJsonActivationCodec,
  });
  if (activated) {
    await store.activate({
      expectedActivationVersion: 0,
      nowMs: T0 * 1000 - 1000,
      createActivationMarker: async () => ({ sequence: 1 }),
    });
  }
  return { store, refCodec };
}

function channelFixture({
  id,
  label,
  accountRef,
  store,
  refCodec,
  batches = [],
  enabled = true,
  connection = 'connected',
  current = () => true,
  generation = 'generation-1',
  counters = {},
  listError = null,
}) {
  Object.assign(counters, {
    enabled: 0, state: 0, acquire: 0, list: 0, release: 0, marker: 0,
    ...counters,
  });
  return {
    id,
    label,
    grouping: { settleMs: id === 'telegram' ? 600_000 : 0, bundleKeyOf: id === 'github'
      ? (msg) => ({ kind: 'issue', id: msg.id })
      : undefined },
    async enabled() { counters.enabled += 1; return enabled; },
    async state() {
      counters.state += 1;
      return { connection, participation: 'active', reason: null, providerSecret: 'не наружу' };
    },
    async acquireInboxContext() {
      counters.acquire += 1;
      return {
        accountRef,
        generation,
        inboxState: store,
        refCodec,
        async createActivationMarker() { counters.marker += 1; return { sequence: 2 + counters.marker }; },
        async listAuthorizedBatches(options) {
          counters.list += 1;
          if (listError) throw listError;
          return typeof batches === 'function' ? batches(options) : clone(batches);
        },
        sourceUrl({ source, message: ownMessage }) {
          return `https://example.test/${encodeURIComponent(source.id)}/${encodeURIComponent(ownMessage.id)}`;
        },
        async materializeAttachments(attachments) { return { files: attachments, skipped: [] }; },
        async isCurrent() { return current(); },
        async release() { counters.release += 1; },
      };
    },
  };
}

const clone = (value) => structuredClone(value);
const batch = (msg, over = {}) => ({
  activationEpoch: 1,
  source: clone(msg.source),
  messages: [msg],
  policy: policy(),
  truncated: false,
  ...over,
});

test('два канала с одинаковыми native IDs merge независимо и сортируются детерминированно', async (t) => {
  const telegramAccount = 'acc_coord_telegram_01';
  const githubAccount = 'acc_coord_github_0001';
  const telegramState = await stateFixture(t, 'telegram', telegramAccount);
  const githubState = await stateFixture(t, 'github', githubAccount);
  const telegramMessage = message({ channel: 'telegram', accountRef: telegramAccount });
  const githubMessage = message({
    channel: 'github', accountRef: githubAccount,
    over: { occurredAt: T0 + 1 },
  });
  const telegramCounters = {};
  const githubCounters = {};
  const coordinator = new InboxCoordinator({ channels: [
    channelFixture({
      id: 'telegram', label: 'Telegram', accountRef: telegramAccount,
      ...telegramState, batches: [batch(telegramMessage)], counters: telegramCounters,
    }),
    channelFixture({
      id: 'github', label: 'GitHub Issues', accountRef: githubAccount,
      ...githubState, batches: [batch(githubMessage)], counters: githubCounters,
    }),
  ] });

  const result = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.deepEqual(result.items.map((item) => item.channel.id), ['github', 'telegram']);
  assert.notEqual(result.items[0].ref, result.items[1].ref);
  assert.equal(result.errors.length, 0);
  assert.equal(telegramCounters.release, 1);
  assert.equal(githubCounters.release, 1);
});

test('public mapper рекурсивно не выпускает account/epoch/native IDs/opaque attachment refs', async (t) => {
  const accountRef = 'acc_coord_public_0001';
  const state = await stateFixture(t, 'telegram', accountRef);
  const ownMessage = message({ channel: 'telegram', accountRef, sourceId: 'native-secret-source' });
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state, batches: [batch(ownMessage)],
  })] });
  const result = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  const item = result.items[0];

  assert.deepEqual(Object.keys(item.source).sort(), ['title', 'url']);
  assert.deepEqual(item.autoTask, {
    enabled: false,
    readyAtMs: (T0 + 600) * 1000,
  });
  assert.deepEqual(Object.keys(item.messages[0].author), ['name']);
  assert.deepEqual(Object.keys(item.messages[0].attachments[0]).sort(), [
    'displayLabel', 'kind', 'name', 'size',
  ]);
  assert.equal('activationEpoch' in item, false);
  assert.equal('accountRef' in item, false);
  const serialized = JSON.stringify(item);
  assert.ok(!serialized.includes(accountRef));
  assert.ok(!serialized.includes('opaque-ref'));
  assert.ok(!serialized.includes('opaque-key'));
  assert.ok(!serialized.includes('scope:1'));
  assert.ok(!serialized.includes('providerSecret'));
});

test('activationEpoch запрещает merge, а decision coverage проектирует skipped/new отдельно', async (t) => {
  const accountRef = 'acc_coord_epochs_0001';
  const state = await stateFixture(t, 'telegram', accountRef);
  await state.store.deactivate({
    expectedActivationVersion: 1,
    nowMs: T0 * 1000,
    createActivationMarker: async () => ({ sequence: 2 }),
  });
  await state.store.activate({
    expectedActivationVersion: 2,
    nowMs: T0 * 1000 + 1000,
    createActivationMarker: async () => ({ sequence: 3 }),
  });
  const first = message({ channel: 'telegram', accountRef, id: '1' });
  const second = message({
    channel: 'telegram', accountRef, id: '2',
    over: { occurredAt: T0 + 1 },
  });
  await state.store.decide({
    activationEpoch: 1,
    originItemRef: state.refCodec.item('old-bundle'),
    messageRefs: [state.refCodec.message(first.source.id, first.id)],
    scopeRef: state.refCodec.scope('scope:1'),
    status: 'skipped',
    by: 'human',
    decidedAtMs: T0 * 1000 + 2000,
  });
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state,
    batches: [batch(first), batch(second, { activationEpoch: 2 })],
  })] });
  const result = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.equal(result.items.length, 2);
  assert.deepEqual(new Set(result.items.map((item) => item.status)), new Set(['new', 'skipped']));

  const worker = await coordinator.workerSnapshot({ nowMs: (T0 + 700) * 1000 });
  assert.equal(worker.channels.length, 1);
  assert.equal(worker.channels[0].generation, 'generation-1');
  assert.equal(worker.channels[0].decisions.length, 1);
  assert.equal(worker.channels[0].decisions[0].scopeRef, state.refCodec.scope('scope:1'));
  assert.equal(state.refCodec.decode(worker.channels[0].items[0].ref, 'item').accountRef, accountRef);
  assert.ok(worker.channels[0].items.some((item) => (
    item.messages[0].attachments[0].ref.startsWith('opaque-ref-')
  )), 'worker snapshot остаётся server-only и пригоден для materialize/task CAS');
});

test('ошибка одного канала partial, secret error не отражается; disabled channel не вызывается', async (t) => {
  const goodAccount = 'acc_coord_good_000001';
  const badAccount = 'acc_coord_bad_0000001';
  const disabledAccount = 'acc_coord_off_0000001';
  const goodState = await stateFixture(t, 'telegram', goodAccount);
  const badState = await stateFixture(t, 'github', badAccount);
  const disabledState = await stateFixture(t, 'mail', disabledAccount);
  const goodMessage = message({ channel: 'telegram', accountRef: goodAccount });
  const badCounters = {};
  const disabledCounters = {};
  const coordinator = new InboxCoordinator({ channels: [
    channelFixture({
      id: 'telegram', label: 'Telegram', accountRef: goodAccount,
      ...goodState, batches: [batch(goodMessage)],
    }),
    channelFixture({
      id: 'github', label: 'GitHub', accountRef: badAccount, ...badState,
      counters: badCounters,
      listError: Object.assign(new Error('token super-secret-token failed'), { code: 'provider_failed' }),
    }),
    channelFixture({
      id: 'mail', label: 'Mail', accountRef: disabledAccount, ...disabledState,
      counters: disabledCounters, enabled: false,
    }),
  ] });
  const result = await coordinator.list({ nowMs: (T0 + 700) * 1000 });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.errors.map((error) => error.channel), ['github']);
  assert.ok(!JSON.stringify(result.errors).includes('super-secret-token'));
  assert.equal(badCounters.release, 1);
  assert.equal(disabledCounters.state, 0);
  assert.equal(disabledCounters.acquire, 0);
  assert.equal(disabledCounters.list, 0);
  assert.deepEqual(
    Object.fromEntries([
      'activationVersion', 'currentEpoch', 'startedAtMs', 'endedAtMs', 'endReason',
    ].map((key) => [key, result.channels[2][key]])),
    {
      activationVersion: 0,
      currentEpoch: null,
      startedAtMs: null,
      endedAtMs: null,
      endReason: null,
    },
  );
});

test('public limit после decisions: свежие skipped не скрывают глубокий new, resolve не зависит от страницы', async (t) => {
  const accountRef = 'acc_coord_deep_queue_01';
  const state = await stateFixture(t, 'github', accountRef);
  const messages = [1, 2, 3, 4, 5].map((id) => message({
    channel: 'github',
    accountRef,
    id: String(id),
    over: {
      occurredAt: T0 + id,
      text: `Обращение ${id}`,
    },
  }));
  for (const ownMessage of messages.slice(0, 2)) {
    await state.store.decide({
      activationEpoch: 1,
      originItemRef: state.refCodec.item(`seed-${ownMessage.id}`),
      messageRefs: [state.refCodec.message(ownMessage.source.id, ownMessage.id)],
      scopeRef: state.refCodec.scope('scope:1'),
      status: 'task',
      taskId: `T-${ownMessage.id}`,
      taskUrl: `https://b24.example/task/${ownMessage.id}`,
      by: 'human',
      note: '',
      decidedAtMs: (T0 + 100 + Number(ownMessage.id)) * 1000,
    });
  }
  for (const ownMessage of messages.slice(3)) {
    await state.store.decide({
      activationEpoch: 1,
      originItemRef: state.refCodec.item(`seed-${ownMessage.id}`),
      messageRefs: [state.refCodec.message(ownMessage.source.id, ownMessage.id)],
      scopeRef: state.refCodec.scope('scope:1'),
      status: 'skipped',
      taskId: null,
      taskUrl: '',
      by: 'human',
      note: '',
      decidedAtMs: (T0 + 100 + Number(ownMessage.id)) * 1000,
    });
  }

  const scanLimits = [];
  const allBatches = messages.map((ownMessage) => batch(ownMessage));
  const coordinator = new InboxCoordinator({
    limit: 2,
    channels: [channelFixture({
      id: 'github',
      label: 'GitHub Issues',
      accountRef,
      ...state,
      batches: ({ limit }) => {
        scanLimits.push(limit);
        return clone(allBatches.slice(0, limit));
      },
    })],
  });

  const listed = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  const refs = listed.items.map((item) => item.messages[0].messageRef);
  const deepMessageRef = state.refCodec.message('source:1', '3');
  assert.deepEqual(refs, [state.refCodec.message('source:1', '5'), deepMessageRef]);
  assert.deepEqual(listed.items.map((item) => item.status), ['skipped', 'new']);
  assert.equal(listed.truncated, true);
  assert.equal(listed.channels[0].truncated, true);
  assert.deepEqual(scanLimits, [10_000], 'adapter получает scan budget, а не public limit');

  const deepItem = listed.items.find((item) => item.messages[0].messageRef === deepMessageRef);
  const resolved = await coordinator.resolveItem(deepItem.ref, { nowMs: (T0 + 700) * 1000 });
  try {
    assert.equal(resolved.item.messages[0].messageRef, deepMessageRef);
    assert.equal(resolved.item.status, 'new');
  } finally {
    await resolved.release();
  }
  assert.deepEqual(scanLimits, [10_000, 10_000], 'resolve повторяет authoritative полный scan');

  const summary = await coordinator.summary({ nowMs: (T0 + 700) * 1000 });
  assert.equal(summary.newCount, 1);
  assert.equal(summary.truncated, true);
});

test('summary считает всю очередь, а не только selected public page', async (t) => {
  const accountRef = 'acc_coord_summary_full_01';
  const state = await stateFixture(t, 'github', accountRef);
  const allBatches = [1, 2, 3].map((id) => batch(message({
    channel: 'github',
    accountRef,
    id: String(id),
    over: { occurredAt: T0 + id },
  })));
  const coordinator = new InboxCoordinator({
    limit: 2,
    channels: [channelFixture({
      id: 'github', label: 'GitHub Issues', accountRef, ...state, batches: allBatches,
    })],
  });

  const listed = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.equal(listed.items.length, 2);
  const summary = await coordinator.summary({ nowMs: (T0 + 700) * 1000 });
  assert.equal(summary.newCount, 3);
  assert.equal(summary.mixedCount, 0);
  assert.equal(summary.reviewCount, 3);
  assert.equal(summary.truncated, true);
  assert.deepEqual(summary.channels[0], {
    id: 'github', newCount: 3, mixedCount: 0, reviewCount: 3, truncated: true,
  });
});

test('summary reviewCount совпадает с вкладкой «К разбору» и включает hot new и mixed', async (t) => {
  const accountRef = 'acc_coord_review_count1';
  const state = await stateFixture(t, 'telegram', accountRef);
  const decided = message({ channel: 'telegram', accountRef, id: '1' });
  const fresh = message({
    channel: 'telegram', accountRef, id: '2',
    over: { occurredAt: T0 + 1 },
  });
  const hot = message({
    channel: 'telegram', accountRef, sourceId: 'source:hot', id: '3',
    over: { occurredAt: T0 + 699 },
  });
  await state.store.decide({
    activationEpoch: 1,
    originItemRef: state.refCodec.item('seed-review-count'),
    messageRefs: [state.refCodec.message(decided.source.id, decided.id)],
    scopeRef: state.refCodec.scope('scope:1'),
    status: 'skipped',
    taskId: null,
    taskUrl: '',
    by: 'human',
    note: '',
    decidedAtMs: (T0 + 10) * 1000,
  });
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state,
    batches: [
      batch(decided, { messages: [decided, fresh] }),
      batch(hot),
    ],
  })] });

  const summary = await coordinator.summary({ nowMs: (T0 + 700) * 1000 });
  assert.equal(summary.newCount, 0, 'hot new ещё не готов автомату');
  assert.equal(summary.mixedCount, 1);
  assert.equal(summary.reviewCount, 2, 'обе карточки уже видны человеку в «К разбору»');
  assert.deepEqual(summary.channels[0], {
    id: 'telegram', newCount: 0, mixedCount: 1, reviewCount: 2, truncated: false,
  });
});

test('карточка, разобранная НЕСКОЛЬКИМИ решениями, уходит из очереди целиком', async (t) => {
  const accountRef = 'acc_coord_split_done_01';
  const state = await stateFixture(t, 'telegram', accountRef);
  const first = message({ channel: 'telegram', accountRef, id: '1' });
  const second = message({
    channel: 'telegram', accountRef, id: '2', over: { occurredAt: T0 + 1 },
  });
  const decide = (id, status, target) => state.store.decide({
    activationEpoch: 1,
    originItemRef: state.refCodec.item('seed-split-done'),
    messageRefs: [state.refCodec.message(target.source.id, target.id)],
    scopeRef: state.refCodec.scope('scope:1'),
    status,
    taskId: status === 'task' ? id : null,
    taskUrl: '',
    by: 'auto',
    note: '',
    decidedAtMs: (T0 + 10) * 1000,
  });
  // Обычный исход разбиения: одно сообщение стало задачей, второе пропущено.
  await decide('8300', 'task', first);
  await decide(null, 'skipped', second);

  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state,
    batches: [batch(first, { messages: [first, second] })],
  })] });

  const listed = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].status, 'mixed', 'разные решения дают mixed при полном покрытии');
  assert.ok(listed.items[0].messages.every((entry) => entry.decision));

  // По статусу такая карточка висела бы в «К разбору» вечно, не предлагая ни одной кнопки.
  const summary = await coordinator.summary({ nowMs: (T0 + 700) * 1000 });
  assert.equal(summary.mixedCount, 1);
  assert.equal(summary.reviewCount, 0, 'нерешённых сообщений не осталось — очередь пуста');
  assert.equal(summary.newCount, 0);
});

test('исчерпанный channel scan становится degraded и не публикует partial items', async (t) => {
  const accountRef = 'acc_coord_scan_cap_0001';
  const state = await stateFixture(t, 'github', accountRef);
  const ownMessage = message({ channel: 'github', accountRef });
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'github',
    label: 'GitHub Issues',
    accountRef,
    ...state,
    batches: [batch(ownMessage, { truncated: true })],
  })] });

  const result = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.errors.map((error) => error.code), ['github_inbox_scan_truncated']);
  assert.equal(result.channels[0].connection, 'degraded');
  assert.equal(result.channels[0].readOnly, true);
});

test('never_activated не читает history, stale generation не публикует старый item', async (t) => {
  const inactiveAccount = 'acc_coord_inactive_001';
  const staleAccount = 'acc_coord_stale_00001';
  const inactiveState = await stateFixture(t, 'telegram', inactiveAccount, { activated: false });
  const staleState = await stateFixture(t, 'github', staleAccount);
  const inactiveCounters = {};
  const staleCounters = {};
  let currentChecks = 0;
  const coordinator = new InboxCoordinator({ channels: [
    channelFixture({
      id: 'telegram', label: 'Telegram', accountRef: inactiveAccount,
      ...inactiveState, counters: inactiveCounters,
    }),
    channelFixture({
      id: 'github', label: 'GitHub', accountRef: staleAccount, ...staleState,
      counters: staleCounters,
      batches: [batch(message({ channel: 'github', accountRef: staleAccount }))],
      current: () => ++currentChecks < 2,
    }),
  ] });
  const result = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.equal(inactiveCounters.list, 0);
  assert.equal(result.items.length, 0);
  assert.equal(result.errors[0].code, 'account_changed');
  assert.equal(staleCounters.release, 1);
});

test('disconnected channel сохраняет projection read-only; summary/status имеют public shape', async (t) => {
  const accountRef = 'acc_coord_disconnected1';
  const state = await stateFixture(t, 'telegram', accountRef);
  const ownMessage = message({ channel: 'telegram', accountRef });
  const counters = {};
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state,
    batches: [batch(ownMessage)], connection: 'disconnected', counters,
  })] });
  const listed = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.channels[0].readOnly, true);
  assert.equal(listed.channels[0].participation, 'active');
  assert.equal(listed.channels[0].activationVersion, 1);
  assert.equal(listed.channels[0].currentEpoch, 1);
  assert.equal(listed.channels[0].startedAtMs, T0 * 1000 - 1000);
  assert.equal(listed.channels[0].endedAtMs, null);
  assert.equal(listed.channels[0].endReason, null);

  const summary = await coordinator.summary({ nowMs: (T0 + 700) * 1000 });
  assert.equal(summary.newCount, 1);
  assert.equal(summary.mixedCount, 0);
  assert.equal(summary.reviewCount, 1);
  const status = await coordinator.status();
  assert.equal(status.channels[0].connection, 'disconnected');
  assert.equal(status.channels[0].readOnly, true);
  assert.equal(status.channels[0].activationVersion, 1);
  assert.ok(counters.list >= 2, 'summary строит тот же canonical projection');
});

test('activate/deactivate используют server marker, activation CAS и всегда release lease', async (t) => {
  const accountRef = 'acc_coord_activation01';
  const state = await stateFixture(t, 'telegram', accountRef, { activated: false });
  const counters = {};
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state, counters,
  })] });

  await assert.rejects(
    coordinator.activate('telegram', { activationVersion: 0, marker: 'client-marker' }),
    (error) => error.code === 'invalid_request',
  );
  assert.equal(counters.acquire, 0, 'лишние activation поля отвергаются до channel lease');

  const active = await coordinator.activate('telegram', { activationVersion: 0 });
  assert.equal(active.activation.participation, 'active');
  assert.equal(active.activation.activationVersion, 1);
  assert.equal(counters.marker, 1);
  assert.equal(counters.release, 1);

  await coordinator.activate('telegram', { activationVersion: 0 });
  assert.equal(counters.marker, 1, 'идемпотентный activate marker повторно не создаёт');
  const closed = await coordinator.deactivate('telegram', { activationVersion: 1 });
  assert.equal(closed.activation.participation, 'deactivated');
  assert.equal(counters.marker, 2);
  assert.equal(counters.release, 3);

  await assert.rejects(
    coordinator.workerGate(state.refCodec.item('worker-item'), { generation: 'generation-1' }),
    (error) => error.code === 'channel_deactivated',
  );
  assert.equal(counters.release, 4);

  await assert.rejects(
    coordinator.activate('telegram', { activationVersion: 0 }),
    (error) => error.code === 'stale_activation',
  );
  assert.equal(counters.release, 5);
});

test('disconnected channel не может activate/deactivate и не получает lease', async (t) => {
  const accountRef = 'acc_coord_offline_act01';
  const state = await stateFixture(t, 'telegram', accountRef, { activated: false });
  const counters = {};
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state,
    connection: 'disconnected', counters,
  })] });

  await assert.rejects(
    coordinator.activate('telegram', { activationVersion: 0 }),
    (error) => error.code === 'channel_disconnected' && error.statusCode === 409,
  );
  assert.equal(counters.acquire, 0);
  assert.equal(counters.marker, 0);
  await assert.rejects(
    coordinator.workerGate(state.refCodec.item('worker-item'), { generation: 'generation-1' }),
    (error) => error.code === 'channel_disconnected',
  );
  assert.equal(counters.acquire, 0);
});

test('resolveItem передаёт server-only lease с raw refs/policy и release идемпотентен', async (t) => {
  const accountRef = 'acc_coord_resolve_0001';
  const state = await stateFixture(t, 'telegram', accountRef);
  const ownMessage = message({ channel: 'telegram', accountRef });
  const counters = {};
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state,
    batches: [batch(ownMessage)], counters,
  })] });
  const listed = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  const resolved = await coordinator.resolveItem(listed.items[0].ref, { nowMs: (T0 + 700) * 1000 });

  assert.equal(resolved.accountRef, accountRef);
  assert.equal(resolved.item.activationEpoch, 1);
  assert.equal(resolved.item.policy.scopeId, 'scope:1');
  assert.equal(resolved.item.policy.scopeRef, state.refCodec.scope('scope:1'));
  assert.equal(resolved.refCodec, state.refCodec);
  assert.equal(resolved.item.messages[0].attachments[0].ref, 'opaque-ref-telegram-1');
  assert.equal(resolved.item.messages[0].messageRef, state.refCodec.message('source:1', '1'));
  assert.deepEqual(toPublicInboxItem(resolved.item), listed.items[0]);
  assert.equal(typeof resolved.context.materializeAttachments, 'function');

  await coordinator.workerGate(listed.items[0].ref, { generation: 'generation-1' });
  await assert.rejects(
    coordinator.workerGate(listed.items[0].ref, { generation: 'generation-old' }),
    (error) => error.code === 'account_changed',
  );
  await assert.rejects(
    coordinator.workerGate(listed.items[0].ref),
    (error) => error.code === 'invalid_worker_gate',
  );

  const before = counters.release;
  await resolved.context.release();
  await resolved.release();
  await resolved.release();
  assert.equal(counters.release, before + 1);

  const previousAccount = new InboxRefCodec({
    channel: 'telegram', accountRef: 'acc_coord_previous_001',
  }).item('old');
  await assert.rejects(
    coordinator.resolveItem(previousAccount, { nowMs: (T0 + 700) * 1000 }),
    (error) => error instanceof InboxCoordinatorError && error.code === 'account_changed',
  );
});

test('strict batch/policy contract деградирует только виновный channel', async (t) => {
  const accountRef = 'acc_coord_policy_00001';
  const state = await stateFixture(t, 'telegram', accountRef);
  const ownMessage = message({ channel: 'telegram', accountRef });
  const invalid = batch(ownMessage);
  invalid.policy.autoTask.minConfidence = 80;
  const coordinator = new InboxCoordinator({ channels: [channelFixture({
    id: 'telegram', label: 'Telegram', accountRef, ...state, batches: [invalid],
  })] });
  const result = await coordinator.list({ nowMs: (T0 + 700) * 1000 });
  assert.equal(result.items.length, 0);
  assert.equal(result.errors[0].code, 'invalid_channel_contract');
  assert.equal(result.channels[0].readOnly, true);
});
