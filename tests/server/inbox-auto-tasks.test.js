import assert from 'node:assert/strict';
import test from 'node:test';

import { INBOX_AUTO_TICK, InboxAutoTasks } from '../../server/src/lib/inbox/autoTasks.ts';
import { InboxRefCodec } from '../../server/src/lib/inbox/identity.ts';

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const DAY_MS = 86_400_000;
const REVISION = `v1_${'A'.repeat(43)}`;
const log = { info() {}, warn() {}, error() {} };

function inboxItem(channel, id, over = {}) {
  const accountRef = over.accountRef || `acc_auto_${channel}_0001`;
  const refs = new InboxRefCodec({ channel, accountRef });
  const sourceId = `source:${id}`;
  const messageRef = refs.message(sourceId, `message:${id}`);
  const base = {
    ref: refs.item(`item:${id}`),
    revision: REVISION,
    channel,
    channelLabel: channel === 'github' ? 'GitHub Issues' : 'Telegram',
    activationEpoch: 1,
    source: { id: sourceId, title: `Источник ${id}`, threadId: null },
    sourceUrl: `https://example.test/${channel}/${id}`,
    firstAt: Math.floor(NOW / 1000) - 700,
    lastAt: Math.floor(NOW / 1000) - 700,
    cold: true,
    status: 'new',
    decision: null,
    messages: [{
      schema: 1,
      channel,
      accountRef,
      source: { id: sourceId, title: `Источник ${id}`, threadId: null },
      id: `message:${id}`,
      parentId: null,
      groupId: null,
      occurredAt: Math.floor(NOW / 1000) - 700,
      editedAt: null,
      author: { id: 'author:1', name: 'Пользователь' },
      text: `Обращение ${id}`,
      attachments: [],
      service: false,
      messageRef,
      decision: null,
    }],
    attachments: [],
    policy: {
      scopeId: 'scope:1',
      scopeRef: refs.scope('scope:1'),
      project: 'grigdesk',
      kind: 'bug',
      b24: { groupId: 10, responsibleId: 20, priority: 2 },
      autoTask: { enabled: true, minConfidence: 0.8, maxPerDay: 5 },
    },
    draft: {
      title: `Обращение ${id}`,
      description: `Исходный текст ${id}`,
      attachments: [],
      truncated: false,
    },
  };
  const result = { ...base, ...over };
  result.policy = {
    ...base.policy,
    ...(over.policy || {}),
    b24: { ...base.policy.b24, ...(over.policy?.b24 || {}) },
    autoTask: { ...base.policy.autoTask, ...(over.policy?.autoTask || {}) },
  };
  return result;
}

function inboxChannel(id, items, {
  decisions = [],
  generation = 'generation-1',
  state = {},
  error = null,
} = {}) {
  return {
    state: {
      id,
      label: id === 'github' ? 'GitHub Issues' : 'Telegram',
      plugin: 'enabled',
      connection: 'connected',
      participation: 'active',
      readOnly: false,
      ...state,
    },
    generation,
    items,
    decisions,
    error,
  };
}

function verdict(over = {}) {
  return {
    kind: 'bug',
    confidence: 0.95,
    title: 'Исправить ошибку',
    description: 'Подтверждённая проблема.',
    reason: 'Похоже на воспроизводимый дефект.',
    ...over,
  };
}

/**
 * План разбора карточки. По умолчанию — один повод на всю карточку: ровно то,
 * что делал прежний одиночный вердикт.
 */
function plan(...entries) {
  const statements = entries.map((entry, index) => ({
    ...(entry.statement || entry),
    messages: entry.messages || [index + 1],
  }));
  const covered = new Set(statements.flatMap((statement) => statement.messages));
  return { statements, messageCount: covered.size, covered: covered.size };
}

function coded(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function releasableAnalysis(value, onRelease) {
  Object.defineProperty(value, 'release', {
    enumerable: false,
    value: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await onRelease();
    },
  });
  return value;
}

function harness({
  channels = [],
  perTick = 5,
  triage,
  triageReadiness,
  task,
  dismiss,
  gate,
  resolveItem,
  attachmentAnalyzer = null,
  enabled = true,
  configured = true,
  model = { provider: 'claude', model: 'opus' },
  idleMs = 60_000,
} = {}) {
  const calls = {
    snapshot: 0,
    gate: [],
    triage: [],
    readiness: [],
    task: [],
    dismiss: [],
    analysis: [],
    resolve: [],
    model: 0,
    changed: [],
  };
  const live = { enabled, configured, model };
  const coordinator = {
    async workerSnapshot() {
      calls.snapshot += 1;
      return { channels: typeof channels === 'function' ? await channels() : channels };
    },
    async workerGate(ref, options) {
      calls.gate.push({ ref, options });
      if (gate) return gate(ref, options, calls.gate.length);
      return { channel: 'ok' };
    },
    async resolveItem(ref, options) {
      calls.resolve.push({ ref, options });
      if (resolveItem) return resolveItem(ref, options, calls.resolve.length);
      throw new Error('Тестовый сценарий не ожидал resolveItem.');
    },
  };
  const taskService = {
    async task(ref, body, options) {
      calls.task.push({ ref, body, options });
      if (task) return task(ref, body, options, calls.task.length);
      return { taskId: `T-${calls.task.length}` };
    },
    async dismiss(ref, body, options) {
      calls.dismiss.push({ ref, body, options });
      if (dismiss) return dismiss(ref, body, options, calls.dismiss.length);
      return { decision: { decisionId: `D-${calls.dismiss.length}`, version: 1 } };
    },
  };
  const worker = new InboxAutoTasks({
    coordinator,
    taskService,
    b24: { isConfigured: () => live.configured },
    attachmentAnalyzer: attachmentAnalyzer ? {
      async analyze(args) {
        calls.analysis.push(args);
        return attachmentAnalyzer(args, calls.analysis.length);
      },
    } : null,
    triage: triage || (async (args) => {
      calls.triage.push(args);
      return { ok: true, plan: plan(verdict()), model: 'claude/opus' };
    }),
    triageReadiness: triageReadiness || (async (args) => {
      calls.readiness.push(args);
      return { ok: true, ref: args.modelRef };
    }),
    modelRef: async () => {
      calls.model += 1;
      return live.model;
    },
    isEnabled: async () => live.enabled,
    perTick,
    idleMs,
    errorMs: idleMs,
    now: () => NOW,
    onChanged: (event) => calls.changed.push(event),
    log,
  });
  return { worker, calls, live };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('global gates не читают channels и не вызывают модель без Inbox/model/B24', async () => {
  const { worker, calls, live } = harness({
    channels: [inboxChannel('telegram', [inboxItem('telegram', 'one')])],
    enabled: false,
  });

  assert.deepEqual(await worker.tick({ nowMs: NOW }), { ran: false, reason: 'plugin_disabled' });
  live.enabled = true;
  live.model = null;
  assert.deepEqual(await worker.tick({ nowMs: NOW }), { ran: false, reason: 'no_model' });
  live.model = { provider: 'claude', model: 'opus' };
  live.configured = false;
  assert.deepEqual(await worker.tick({ nowMs: NOW }), { ran: false, reason: 'no_b24' });

  assert.equal(calls.snapshot, 0);
  assert.equal(calls.gate.length, 0);
  assert.equal(calls.triage.length, 0);
  assert.equal(calls.task.length, 0);
});

test('public status перепроверяет живые ворота, а не повторяет устаревший lastReason', async () => {
  const { worker, live } = harness();
  live.model = null;
  assert.equal((await worker.publicStatus()).readiness, 'no_model');
  live.model = { provider: 'claude', model: 'opus' };
  live.configured = false;
  assert.equal((await worker.publicStatus()).readiness, 'no_b24');
  live.configured = true;
  assert.equal((await worker.publicStatus()).readiness, 'stopped');
  worker.running = true;
  assert.equal((await worker.publicStatus()).readiness, 'ready');
});

test('worker readiness fail-closed для provider без isolated transport и vision модели', async () => {
  let reason = 'unsafe_model_provider';
  const { worker, calls } = harness({
    channels: [inboxChannel('telegram', [inboxItem('telegram', 'unsafe')])],
    triageReadiness: async (args) => {
      calls.readiness.push(args);
      return { ok: false, error: reason };
    },
  });
  assert.equal((await worker.publicStatus()).readiness, 'unsafe_model_provider');
  assert.deepEqual(await worker.tick({ nowMs: NOW }), {
    ran: false, reason: 'unsafe_model_provider',
  });
  assert.equal(calls.snapshot, 0);
  assert.equal(calls.readiness.every((call) => call.requireImages === true), true);

  reason = 'unsupported_media';
  assert.equal((await worker.publicStatus()).readiness, 'unsupported_media');
  assert.deepEqual(await worker.tick({ nowMs: NOW }), {
    ran: false, reason: 'unsupported_media',
  });
  assert.equal(calls.triage.length, 0);
});

test('inactive/mixed/hot/old/off/max=0/quota исключаются до model call', async () => {
  const quota = inboxItem('telegram', 'quota', {
    policy: { autoTask: { maxPerDay: 1 } },
  });
  const active = [
    inboxItem('telegram', 'mixed', { status: 'mixed' }),
    inboxItem('telegram', 'hot', { cold: false }),
    inboxItem('telegram', 'old', { lastAt: Math.floor((NOW - DAY_MS - 1_000) / 1000) }),
    inboxItem('telegram', 'off', { policy: { autoTask: { enabled: false } } }),
    inboxItem('telegram', 'zero', { policy: { autoTask: { maxPerDay: 0 } } }),
    quota,
  ];
  const decisions = [{
    status: 'task', by: 'auto', scopeRef: quota.policy.scopeRef, decidedAtMs: NOW - DAY_MS,
  }];
  const channels = [
    inboxChannel('telegram', active, { decisions }),
    inboxChannel('github', [inboxItem('github', 'deactivated')], {
      state: { participation: 'deactivated' },
    }),
    inboxChannel('mail', [inboxItem('mail', 'disconnected')], {
      state: { connection: 'disconnected', readOnly: true },
    }),
  ];
  const { worker, calls } = harness({ channels });
  const result = await worker.tick({ nowMs: NOW });

  assert.equal(result.ran, true);
  assert.equal(result.judged, 0);
  assert.equal(calls.triage.length, 0);
  assert.equal(calls.gate.length, 0);
});

test('create и none-dismiss идут через общий service с auto metadata', async () => {
  const create = inboxItem('telegram', 'create');
  const dismiss = inboxItem('github', 'dismiss');
  const { worker, calls } = harness({
    channels: [inboxChannel('telegram', [create]), inboxChannel('github', [dismiss])],
    triage: async (args) => {
      calls.triage.push(args);
      return {
        ok: true,
        plan: plan(args.item.ref === dismiss.ref
          ? verdict({ kind: 'none', reason: 'Это просто благодарность.' })
          : verdict()),
        model: 'claude/opus',
      };
    },
  });
  const result = await worker.tick({ nowMs: NOW });

  assert.equal(result.judged, 2);
  assert.deepEqual(result.created.map((entry) => entry.ref), [create.ref]);
  assert.deepEqual(result.dismissed.map((entry) => entry.ref), [dismiss.ref]);
  assert.deepEqual(calls.task[0].body.messageRefs, [create.messages[0].messageRef]);
  assert.equal(calls.task[0].body.revision, create.revision);
  assert.equal(
    calls.task[0].body.description,
    `Подтверждённая проблема.\n\nИсточник · Telegram: ${create.sourceUrl}`,
  );
  assert.deepEqual(
    { by: calls.task[0].options.by, requireAllAttachments: calls.task[0].options.requireAllAttachments },
    { by: 'auto', requireAllAttachments: true },
  );
  assert.match(calls.task[0].options.note, /claude\/opus/u);
  assert.deepEqual(calls.dismiss[0].options.by, 'auto');
  assert.match(calls.dismiss[0].options.note, /благодарность/u);
  assert.equal(calls.gate.length, 4, 'каждый verdict окружён generation/activation gates');
  assert.ok(calls.gate.every((call) => call.options.generation === 'generation-1'));
});

/** Карточка-разговор: несколько сообщений одного человека подряд. */
function conversation(channel, id, count) {
  const base = inboxItem(channel, id);
  const head = base.messages[0];
  const accountRef = `acc_auto_${channel}_0001`;
  const refs = new InboxRefCodec({ channel, accountRef });
  return {
    ...base,
    messages: Array.from({ length: count }, (unused, index) => ({
      ...head,
      id: `message:${id}:${index + 1}`,
      occurredAt: head.occurredAt + index * 10,
      text: `Сообщение ${index + 1}`,
      messageRef: refs.message(head.source.id, `message:${id}:${index + 1}`),
    })),
  };
}

test('одна карточка разбирается на несколько задач по номерам сообщений', async () => {
  const card = conversation('telegram', 'split', 6);
  const refOf = (index) => card.messages[index - 1].messageRef;
  const revisions = [`v1_${'B'.repeat(43)}`, `v1_${'C'.repeat(43)}`, `v1_${'D'.repeat(43)}`];
  const { worker, calls } = harness({
    channels: [inboxChannel('telegram', [card])],
    triage: async (args) => {
      calls.triage.push(args);
      return {
        ok: true,
        model: 'claude/opus',
        plan: plan(
          { statement: verdict({ description: 'Первая просьба.' }), messages: [1, 2, 3] },
          { statement: verdict({ kind: 'none', reason: 'Просто болтовня.' }), messages: [4] },
          { statement: verdict({ description: 'Вторая просьба.' }), messages: [5, 6] },
        ),
      };
    },
    // Каждое решение меняет revision карточки: следующая постановка обязана взять свежую.
    resolveItem: async (ref, options, callNumber) => ({
      generation: 'generation-1',
      channelState: { readOnly: false, connection: 'connected', participation: 'active' },
      item: { ...card, revision: revisions[callNumber - 1] },
      context: {
        sourceUrl: async ({ message }) => `https://t.me/c/1/${message.id}`,
      },
      release: async () => {},
    }),
  });

  const result = await worker.tick({ nowMs: NOW });

  assert.equal(result.judged, 1, 'разбиение стоит один вызов модели, а не по одному на задачу');
  assert.equal(result.created.length, 2);
  assert.equal(result.dismissed.length, 1);
  assert.deepEqual(
    calls.task.map((call) => call.body.messageRefs),
    [[refOf(1), refOf(2), refOf(3)], [refOf(5), refOf(6)]],
  );
  assert.deepEqual(calls.dismiss[0].body.messageRefs, [refOf(4)]);
  assert.deepEqual(
    [...calls.task.map((call) => call.body.revision), calls.dismiss[0].body.revision],
    [revisions[0], revisions[2], revisions[1]],
  );
  // Ссылка ведёт на первое сообщение своей задачи, а не на голову всего разговора.
  assert.match(calls.task[0].body.description, /Первая просьба\.\n\nИсточник · Telegram: https:\/\/t\.me\/c\/1\/message:split:1$/u);
  assert.match(calls.task[1].body.description, /Вторая просьба\.\n\nИсточник · Telegram: https:\/\/t\.me\/c\/1\/message:split:5$/u);
});

test('разбитая карточка останавливается на первом отказе, остаток остаётся человеку', async () => {
  const card = conversation('telegram', 'partial', 4);
  const { worker, calls } = harness({
    channels: [inboxChannel('telegram', [card])],
    triage: async () => ({
      ok: true,
      model: 'claude/opus',
      plan: plan(
        { statement: verdict(), messages: [1, 2] },
        { statement: verdict(), messages: [3, 4] },
      ),
    }),
    resolveItem: async () => ({
      generation: 'generation-1',
      channelState: { readOnly: false, connection: 'connected', participation: 'active' },
      item: card,
      context: { sourceUrl: async () => 'https://t.me/c/1/2' },
      release: async () => {},
    }),
    task: async (ref, body, options, callNumber) => {
      if (callNumber === 1) throw coded('stale_item');
      return { taskId: 'T-2' };
    },
  });

  const result = await worker.tick({ nowMs: NOW });

  assert.deepEqual(result.created, []);
  assert.deepEqual(result.failed, []);
  assert.equal(calls.task.length, 1, 'после устаревшего состояния второй повод не досылается');
});

test('пока карточка у модели, status показывает judging и SSE будят окна', async () => {
  const item = inboxItem('telegram', 'live');
  let seenDuringTriage = 'not-checked';
  let workerRef = null;
  const ctx = harness({
    channels: [inboxChannel('telegram', [item])],
    triage: async () => {
      // Внутри model call все окна обязаны видеть, какую карточку разбирают.
      seenDuringTriage = workerRef.status().judging;
      return { ok: true, plan: plan(verdict()), model: 'claude/opus' };
    },
  });
  workerRef = ctx.worker;
  const result = await ctx.worker.tick({ nowMs: NOW });
  assert.equal(result.created.length, 1);
  assert.deepEqual(seenDuringTriage, {
    ref: item.ref,
    channel: 'telegram',
    startedAtMs: NOW,
  });
  assert.equal(ctx.worker.status().judging, null, 'после разбора метка снимается');
  assert.deepEqual(ctx.calls.changed[0], { reason: 'judging' });
  assert.deepEqual(ctx.calls.changed.at(-1), { reason: 'judging-done' });
});

test('вложения обязательно разбираются до модели, а неполный разбор оставляет item человеку', async () => {
  const attachment = {
    ref: 'opaque-file', dedupeKey: 'opaque-unique', kind: 'voice',
    displayLabel: 'голосовое сообщение', name: 'voice.ogg', size: 100,
  };
  const mediaItem = inboxItem('telegram', 'media');
  mediaItem.sourceUrl = 'https://t.me/c/123456/789';
  mediaItem.attachments = [attachment];
  mediaItem.messages[0].attachments = [attachment];
  mediaItem.draft.attachments = [attachment];

  let blockedReleases = 0;
  const blocked = harness({
    channels: [inboxChannel('telegram', [mediaItem])],
    attachmentAnalyzer: async () => releasableAnalysis({
      ok: false,
      complete: false,
      error: 'speech_unavailable',
      text: '',
      visualPaths: [],
      entries: [],
    }, () => { blockedReleases += 1; }),
  });
  const blockedResult = await blocked.worker.tick({ nowMs: NOW });
  assert.equal(blockedResult.judged, 1);
  assert.deepEqual(blockedResult.analysisRequired, [{
    ref: mediaItem.ref, channel: 'telegram', code: 'speech_unavailable',
  }]);
  assert.equal(blocked.calls.triage.length, 0);
  assert.equal(blocked.calls.task.length, 0);
  assert.equal(blockedReleases, 1, 'ранний incomplete path дожидается release');
  assert.deepEqual(blocked.calls.changed, [
    { reason: 'judging' },
    { reason: 'attachment-analysis-required' },
    { reason: 'judging-done' },
  ]);
  assert.deepEqual(blocked.worker.status().analysisRequired, [{
    ref: mediaItem.ref,
    revision: mediaItem.revision,
    code: 'speech_unavailable',
    // Разбор не вернул ни одной записи — перечислять нечего, объясняет код.
    attachments: [],
    checkedAtMs: NOW,
    retryAtMs: NOW + INBOX_AUTO_TICK.attachmentRetryMs,
  }]);
  const changedAfterBlock = blocked.calls.changed.length;
  const cooldown = await blocked.worker.tick({ nowMs: NOW + 1 });
  assert.equal(cooldown.judged, 0);
  assert.equal(blocked.calls.analysis.length, 1, 'неповторяем дорогой разбор каждый минутный tick');
  assert.equal(blocked.calls.changed.length, changedAfterBlock, 'cooldown не шумит повторными SSE');
  await blocked.worker.tick({ nowMs: NOW + INBOX_AUTO_TICK.attachmentRetryMs + 1 });
  assert.equal(blocked.calls.analysis.length, 2, 'после cooldown допускается новая попытка');
  assert.equal(blockedReleases, 2, 'каждая попытка освобождает собственный lease');

  let readyReleases = 0;
  const ready = harness({
    channels: [inboxChannel('telegram', [mediaItem])],
    attachmentAnalyzer: async () => releasableAnalysis({
      ok: true,
      complete: true,
      key: 'media-key',
      text: 'Расшифровка: кнопка сохранения не работает.',
      visualPaths: [],
      entries: [],
    }, () => { readyReleases += 1; }),
  });
  const readyResult = await ready.worker.tick({ nowMs: NOW });
  assert.equal(readyResult.created.length, 1);
  assert.equal(ready.calls.triage.length, 1);
  assert.match(ready.calls.triage[0].attachmentAnalysis.text, /кнопка сохранения/u);
  assert.equal(
    ready.calls.task[0].body.description,
    `Подтверждённая проблема.\n\nИсточник · Telegram: ${mediaItem.sourceUrl}`,
  );
  assert.doesNotMatch(ready.calls.task[0].body.description, /Разбор вложений|Inbox|claude/u);
  assert.equal(readyReleases, 1, 'успешный auto task освобождает analysis lease');

  let incompatibleReleases = 0;
  const incompatible = harness({
    channels: [inboxChannel('telegram', [mediaItem])],
    attachmentAnalyzer: async () => releasableAnalysis({
      ok: true,
      complete: true,
      key: 'visual-key',
      text: '',
      visualPaths: ['/safe/frame.png'],
      entries: [],
    }, () => { incompatibleReleases += 1; }),
    triage: async () => ({ ok: false, error: 'unsupported_media' }),
  });
  const incompatibleResult = await incompatible.worker.tick({ nowMs: NOW });
  assert.deepEqual(incompatibleResult.analysisRequired, [{
    ref: mediaItem.ref, channel: 'telegram', code: 'unsupported_media',
  }]);
  assert.equal(incompatible.calls.task.length, 0);
  assert.equal(incompatible.worker.status().analysisRequired[0].code, 'unsupported_media');
  assert.equal(incompatibleReleases, 1, 'ошибка vision-триажа освобождает visual lease');
});

test('модель без безопасного untrusted transport останавливает tick без решений', async () => {
  const candidate = inboxItem('telegram', 'unsafe-model');
  const own = harness({
    channels: [inboxChannel('telegram', [candidate])],
    triage: async () => ({ ok: false, error: 'executor_unavailable' }),
  });
  const result = await own.worker.tick({ nowMs: NOW });
  assert.equal(result.haltedReason, 'executor_unavailable');
  assert.equal(own.worker.status().lastReason, 'executor_unavailable');
  assert.equal(own.calls.task.length, 0);
  assert.equal(own.calls.dismiss.length, 0);
});

test('ошибка release visual lease не роняет auto tick', async () => {
  const mediaItem = inboxItem('telegram', 'release-rejection');
  const attachment = {
    ref: 'opaque-file', dedupeKey: 'opaque-release', kind: 'image',
    displayLabel: 'скриншот', name: 'bug.png', size: 100,
  };
  mediaItem.attachments = [attachment];
  mediaItem.messages[0].attachments = [attachment];
  mediaItem.draft.attachments = [attachment];
  let releaseAttempts = 0;
  const own = harness({
    channels: [inboxChannel('telegram', [mediaItem])],
    attachmentAnalyzer: async () => releasableAnalysis({
      ok: true,
      complete: true,
      key: 'visual-key',
      text: 'На скриншоте ошибка.',
      visualPaths: ['/safe/frame.png'],
      entries: [],
    }, async () => {
      releaseAttempts += 1;
      throw Object.assign(new Error('cleanup failed'), { code: 'cleanup_failed' });
    }),
  });

  const result = await own.worker.tick({ nowMs: NOW });
  assert.equal(releaseAttempts, 1);
  assert.equal(result.created.length, 1);
  assert.equal(own.calls.task.length, 1);
});

test('rolling quota точна по typed scope, а made учитывает задачи этого tick', async () => {
  const first = inboxItem('telegram', 'first', { policy: { autoTask: { maxPerDay: 1 } } });
  const second = inboxItem('telegram', 'second', { policy: {
    scopeRef: first.policy.scopeRef,
    autoTask: { maxPerDay: 1 },
  } });
  const blocked = inboxItem('github', 'blocked', { policy: { autoTask: { maxPerDay: 1 } } });
  const allowed = inboxItem('github', 'allowed', {
    accountRef: 'acc_auto_github_0002',
    policy: { autoTask: { maxPerDay: 1 } },
  });
  const decisions = [
    { status: 'task', by: 'human', scopeRef: blocked.policy.scopeRef, decidedAtMs: NOW - 1 },
    { status: 'skipped', by: 'auto', scopeRef: blocked.policy.scopeRef, decidedAtMs: NOW - 1 },
    { status: 'task', by: 'auto', scopeRef: blocked.policy.scopeRef, decidedAtMs: NOW - DAY_MS },
  ];
  const { worker, calls } = harness({
    channels: [
      inboxChannel('telegram', [first, second]),
      inboxChannel('github', [blocked, allowed], { decisions }),
    ],
  });
  await worker.tick({ nowMs: NOW });

  assert.deepEqual(new Set(calls.task.map((call) => call.ref)), new Set([first.ref, allowed.ref]));
  assert.equal(calls.triage.length, 2);
});

test('round-robin даёт второму каналу слот при малом perTick', async () => {
  const telegram = ['a1', 'a2', 'a3'].map((id) => inboxItem('telegram', id));
  const github = inboxItem('github', 'b1');
  const { worker, calls } = harness({
    channels: [inboxChannel('telegram', telegram), inboxChannel('github', [github])],
    perTick: 2,
  });
  const result = await worker.tick({ nowMs: NOW });

  assert.deepEqual(calls.triage.map((call) => call.item.ref), [telegram[0].ref, github.ref]);
  assert.equal(result.judged, 2);
  assert.equal(result.left, 2);
});

test('round-robin продолжает со следующего канала, когда perTick меньше числа каналов', async () => {
  const telegram = inboxItem('telegram', 'only-a');
  const github = inboxItem('github', 'only-b');
  const { worker, calls } = harness({
    channels: [inboxChannel('telegram', [telegram]), inboxChannel('github', [github])],
    perTick: 1,
    triage: async (args) => {
      calls.triage.push(args);
      return { ok: true, plan: plan(verdict({ confidence: 0.1 })), model: 'claude/opus' };
    },
  });

  await worker.tick({ nowMs: NOW });
  await worker.tick({ nowMs: NOW + 1 });

  assert.deepEqual(calls.triage.map((call) => call.item.ref), [telegram.ref, github.ref]);
});

test('fair cursor не даёт нерешаемой голове навсегда закрыть глубокий item', async () => {
  const blocked = ['stuck-1', 'stuck-2', 'stuck-3', 'stuck-4', 'stuck-5']
    .map((id) => inboxItem('telegram', id));
  const deep = inboxItem('telegram', 'deep-create');
  let fixture;
  fixture = harness({
    channels: [inboxChannel('telegram', [...blocked, deep])],
    perTick: 5,
    triage: async (args) => {
      fixture.calls.triage.push(args);
      if (args.item.ref === deep.ref) {
        return { ok: true, plan: plan(verdict()), model: 'claude/opus' };
      }
      const index = blocked.findIndex((item) => item.ref === args.item.ref);
      return index < 2
        ? { ok: false, error: 'triage_failed' }
        : { ok: true, plan: plan(verdict({ confidence: 0.1 })), model: 'claude/opus' };
    },
  });

  const first = await fixture.worker.tick({ nowMs: NOW });
  assert.equal(first.judged, 5);
  assert.equal(first.left, 1);
  assert.deepEqual(fixture.calls.task, []);
  assert.deepEqual(
    fixture.calls.triage.map((call) => call.item.ref),
    blocked.map((item) => item.ref),
  );

  const second = await fixture.worker.tick({ nowMs: NOW + 1 });
  assert.equal(second.judged, 5);
  assert.equal(fixture.calls.triage[5].item.ref, deep.ref,
    'следующий tick начинает после последнего реально проверенного item');
  assert.deepEqual(fixture.calls.task.map((call) => call.ref), [deep.ref]);
});

test('generation/activation/model recheck отбрасывает устаревший model result', async () => {
  const candidate = inboxItem('telegram', 'race');
  let gates = 0;
  const first = harness({
    channels: [inboxChannel('telegram', [candidate])],
    gate: async () => {
      gates += 1;
      if (gates === 2) throw coded('channel_deactivated');
    },
  });
  await first.worker.tick({ nowMs: NOW });
  assert.equal(first.calls.triage.length, 1);
  assert.equal(first.calls.task.length, 0);

  let second;
  second = harness({
    channels: [inboxChannel('telegram', [candidate])],
    triage: async (args) => {
      second.calls.triage.push(args);
      second.live.model = { provider: 'codex', model: 'gpt' };
      return { ok: true, plan: plan(verdict()), model: 'claude/opus' };
    },
  });
  const result = await second.worker.tick({ nowMs: NOW });
  assert.equal(result.haltedReason, 'model_changed');
  assert.equal(second.calls.task.length, 0);
});

test('stale/skipped attachments остаются человеку, indeterminate блокирует только channel', async () => {
  const stale = inboxItem('telegram', 'stale');
  const uncertain = inboxItem('telegram', 'uncertain');
  const other = inboxItem('github', 'other');
  const { worker, calls } = harness({
    channels: [
      inboxChannel('telegram', [stale, uncertain]),
      inboxChannel('github', [other]),
    ],
    task: async (ref) => {
      if (ref === stale.ref) throw coded('attachments_skipped');
      if (ref === uncertain.ref) {
        throw coded('indeterminate_task_commit', { taskId: 'T-uncertain' });
      }
      return { taskId: 'T-other' };
    },
  });
  const first = await worker.tick({ nowMs: NOW });

  assert.deepEqual(first.failed, [{
    ref: uncertain.ref, channel: 'telegram', code: 'indeterminate_task_commit',
  }]);
  assert.deepEqual(first.created, [{ ref: other.ref, channel: 'github', taskId: 'T-other' }]);
  assert.deepEqual(worker.status().blockedChannels, ['telegram']);

  calls.triage.length = 0;
  await worker.tick({ nowMs: NOW + 1 });
  assert.ok(calls.triage.every((call) => call.item.channel === 'github'));
});

test('loop просыпается после enable без restart и stop отменяет model result', async (t) => {
  const wake = harness({ channels: [], enabled: false, idleMs: 10 });
  t.after(() => wake.worker.stop());
  wake.worker.start();
  await waitFor(() => wake.worker.status().lastReason === 'plugin_disabled');
  assert.equal(wake.calls.snapshot, 0);
  wake.live.enabled = true;
  await waitFor(() => wake.calls.snapshot > 0);
  wake.worker.stop();
  assert.equal(wake.worker.status().running, false);

  let modelStarted = false;
  const candidate = inboxItem('telegram', 'abort');
  const stopped = harness({
    channels: [inboxChannel('telegram', [candidate])],
    idleMs: 10,
    triage: ({ signal }) => new Promise((resolve) => {
      modelStarted = true;
      signal.addEventListener('abort', () => resolve({
        ok: true, plan: plan(verdict()), model: 'claude/opus',
      }), { once: true });
    }),
  });
  t.after(() => stopped.worker.stop());
  stopped.worker.start();
  await waitFor(() => modelStarted);
  stopped.worker.stop();
  await stopped.worker.tickQueue;
  assert.equal(stopped.calls.task.length, 0);
  assert.equal(stopped.worker.status().lastReason, 'stopped');
});
