import assert from 'node:assert/strict';
import test from 'node:test';

import { InboxCoordinator } from '../../server/src/lib/inbox/coordinator.js';
import { InboxRefCodec } from '../../server/src/lib/inbox/identity.js';
import { normalizeRules } from '../../server/src/lib/telegram/rules-store.js';
import { normalizeUpdate } from '../../server/src/lib/telegram/updates.js';
import {
  createTelegramInboxChannel,
  TelegramInboxChannelError,
  toInboxMessage,
} from '../../server/src/lib/telegram/inbox-channel.js';
import { telegramActivationMarker } from '../../server/src/lib/telegram/activation.js';

const ACCOUNT_REF = 'acc_telegram_inbox_0001';
const BOT_ID = '8123456789';
const TOKEN = `${BOT_ID}:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6`;
const CHAT = -1001000000042;
const THREAD = 42;
const T0 = 1_786_172_400;
const FILE_LIMIT = 20 * 1024 * 1024;
const MAX_MATERIALIZED_ATTACHMENTS = 12;
const MAX_MATERIALIZED_BYTES = 80 * 1024 * 1024;

const marker = (afterSeq, afterOccurredAt) => ({ schema: 1, afterSeq, afterOccurredAt });
const windows = (startSeq = 0, startAt = T0 - 1) => [
  { epoch: 1, startMarker: marker(startSeq, startAt), endMarker: null },
];

const nativeMessage = (over = {}) => ({
  chatId: CHAT,
  chatUsername: '',
  chatTitle: 'Команда Альфа · разработка',
  chatType: 'supergroup',
  isForum: true,
  messageId: 100,
  threadId: THREAD,
  replyToMessageId: null,
  mediaGroupId: null,
  date: T0,
  editedAt: null,
  from: { id: 42, name: 'Аня', username: 'anya' },
  text: 'Баг / кнопка не нажимается',
  media: [],
  ...over,
});

function position(snapshot, seq, over = {}) {
  return {
    seq,
    occurredAt: snapshot.date,
    revisionSeq: seq,
    chatId: snapshot.chatId,
    chatUsername: snapshot.chatUsername || '',
    threadId: snapshot.threadId ?? null,
    messageId: snapshot.messageId,
    ...over,
  };
}

const defaultRule = (over = {}) => normalizeRules([{
  project: 'cockpit',
  chatId: CHAT,
  threadId: THREAD,
  kind: 'bug',
  title: 'Команда Альфа · разработка · Баги',
  b24: { groupId: 42, responsibleId: 5, priority: 2 },
  autoTask: { enabled: false, minConfidence: 0.7, maxPerDay: 10 },
  ...over,
}])[0];

function inboxState({ activationWindows = windows() } = {}) {
  const refCodec = new InboxRefCodec({ channel: 'telegram', accountRef: ACCOUNT_REF });
  const state = {
    schemaVersion: 1,
    channel: 'telegram',
    accountRef: ACCOUNT_REF,
    activation: {
      version: 1,
      epochs: [{
        epoch: 1,
        startedAtMs: (T0 - 1) * 1000,
        startMarker: marker(0, T0 - 1),
        endedAtMs: null,
        endMarker: null,
        endReason: null,
      }],
    },
    updatedAtMs: (T0 - 1) * 1000,
    decisions: [],
  };
  return {
    refCodec,
    async read() { return structuredClone(state); },
    async summary() {
      return {
        participation: 'active', activationVersion: 1, currentEpoch: 1,
        startedAtMs: state.activation.epochs[0].startedAtMs,
        endedAtMs: null, endReason: null,
      };
    },
    async activationWindows() { return structuredClone(activationWindows); },
    async activate() {},
    async deactivate() {},
  };
}

function harness({
  snapshots = [nativeMessage()],
  positions = null,
  channelRules = [defaultRule()],
  connection = 'connected',
  credentials = { botId: BOT_ID, token: TOKEN },
  current = () => true,
  pluginEnabled = () => true,
  onRules = null,
  onPositions = null,
  onRead = null,
  onMarker = null,
  botApi = null,
  nativeExtras = {},
} = {}) {
  const byMessage = new Map(snapshots.map((snapshot) => [snapshot.messageId, snapshot]));
  const rows = positions || snapshots.map((snapshot, index) => position(snapshot, index + 1));
  const counters = {
    acquire: 0, release: 0, rules: 0, positions: 0, read: 0, marker: 0,
  };
  const archive = {
    async head() { return rows.reduce((max, row) => Math.max(max, row.revisionSeq), 0); },
    async listInboxPositions({ afterSeq, throughSeq, limit }) {
      counters.positions += 1;
      onPositions?.();
      const upper = throughSeq ?? Number.MAX_SAFE_INTEGER;
      return structuredClone(rows
        .filter((row) => row.seq > afterSeq && row.seq <= upper)
        .slice(0, limit));
    },
    async readInboxPosition(row) {
      counters.read += 1;
      onRead?.();
      return structuredClone(byMessage.get(row.messageId));
    },
  };
  const rules = {
    async read() {
      counters.rules += 1;
      onRules?.();
      return structuredClone(channelRules);
    },
  };
  const api = {
    async callBotApi() { return true; },
    ...(botApi || {
    async getFile(_token, fileId) { return { fileId, filePath: `files/${fileId}`, size: 1 }; },
    async downloadFile() { return Buffer.from('x'); },
    }),
  };
  const stateStore = inboxState();
  const capability = createTelegramInboxChannel({
    enabled: async () => pluginEnabled(),
    state: async () => ({
      connection,
      participation: 'active',
      reason: null,
      token: TOKEN,
      botId: BOT_ID,
      providerIdentity: [1, 'api.telegram.org', 'bot', BOT_ID],
    }),
    acquireInboxLease: async () => {
      counters.acquire += 1;
      return {
        accountRef: ACCOUNT_REF,
        generation: 'telegram-generation-1',
        context: {
          botId: BOT_ID,
          archive,
          rules,
          inboxState: stateStore,
          credentials,
          botApi: api,
          async createActivationMarker({ nowMs, occurredAt = null }) {
            counters.marker += 1;
            onMarker?.();
            return telegramActivationMarker({
              afterSeq: await archive.head(),
              nowMs,
              occurredAt,
            });
          },
          token: TOKEN,
          ...nativeExtras,
        },
        isCurrent: current,
        release() { counters.release += 1; },
      };
    },
  });
  return { capability, counters, archive, rules, inboxState: stateStore };
}

test('mapping принимает normalizeUpdate(...).msg и не протаскивает Telegram native поля', () => {
  const normalized = normalizeUpdate({
    update_id: 1,
    message: {
      message_id: 20425,
      message_thread_id: THREAD,
      media_group_id: 'album-7',
      date: T0,
      chat: { id: CHAT, title: 'Команда Альфа · разработка', type: 'supergroup', is_forum: true },
      sender_chat: { id: -100999, title: 'Канал' },
      caption: 'скриншот',
      photo: [{ file_id: 'small', file_unique_id: 'u-small', width: 10, height: 10 }, {
        file_id: 'large', file_unique_id: 'u-large', width: 100, height: 100, file_size: 123,
      }],
    },
  });
  const mapped = toInboxMessage(normalized.msg, { accountRef: ACCOUNT_REF });
  assert.deepEqual(mapped, {
    schema: 1,
    channel: 'telegram',
    accountRef: ACCOUNT_REF,
    source: { id: String(CHAT), title: 'Команда Альфа · разработка', threadId: String(THREAD) },
    id: '20425',
    parentId: null,
    groupId: 'album-7',
    occurredAt: T0,
    editedAt: null,
    author: { id: '-100999', name: 'Канал' },
    text: 'скриншот',
    attachments: [{
      ref: 'large', dedupeKey: 'u-large', kind: 'image', displayLabel: 'фото', name: '', size: 123,
    }],
    service: false,
  });
  for (const forbidden of ['chatUsername', 'chatType', 'isForum', 'username', 'fileId']) {
    assert.equal(JSON.stringify(mapped).includes(`"${forbidden}"`), false);
  }
});

test('capability фиксирует Telegram grouping 600 секунд и public state projection', async () => {
  const { capability } = harness();
  assert.equal(capability.id, 'telegram');
  assert.equal(capability.label, 'Telegram');
  assert.deepEqual(capability.grouping, { settleMs: 600_000 });
  assert.equal(await capability.enabled(), true);
  const state = await capability.state();
  assert.deepEqual(state, { connection: 'connected', participation: 'active', reason: null });
  for (const forbidden of [TOKEN, BOT_ID, 'providerIdentity']) {
    assert.equal(JSON.stringify(state).includes(forbidden), false);
  }
});

test('authorized native row становится strict batch с topic policy scope', async () => {
  const { capability, counters } = harness();
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000,
      limit: 100,
      activationWindows: windows(),
    });
    assert.equal(batches.length, 1);
    const [batch] = batches;
    assert.equal(batch.activationEpoch, 1);
    assert.deepEqual(batch.source, {
      id: String(CHAT), title: 'Команда Альфа · разработка', threadId: String(THREAD),
    });
    assert.deepEqual(batch.messages.map((message) => message.id), ['100']);
    assert.equal(batch.policy.project, 'cockpit');
    assert.equal(batch.policy.kind, 'bug');
    assert.deepEqual(batch.policy.b24, { responsibleId: 5, groupId: 42, priority: 2 });
    assert.deepEqual(batch.policy.autoTask, { enabled: false, minConfidence: 0.7, maxPerDay: 10 });
    assert.match(batch.policy.scopeId, /^[A-Za-z0-9_-]+$/u);
    assert.equal(batch.truncated, false);
    assert.equal(context.sourceUrl({ source: batch.source, message: batch.messages[0] }),
      `https://t.me/c/1000000042/${THREAD}/100`);
    assert.equal(counters.rules, 1);
    assert.equal(counters.read, 1);
  } finally {
    await context.release();
    await context.release();
  }
  assert.equal(counters.release, 1);
});

test('включённое правило отвечает номером, названием и ссылкой в exact чат и тему', async () => {
  const calls = [];
  const { capability } = harness({
    channelRules: [defaultRule({ notifyTaskCreated: true })],
    botApi: {
      async getFile() {},
      async downloadFile() {},
      async callBotApi(token, method, body, options) {
        calls.push({ token, method, body, options });
        return { message_id: 9_001 };
      },
    },
  });
  const context = await capability.acquireInboxContext();
  try {
    const [batch] = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000,
      limit: 10,
      activationWindows: windows(),
    });
    const [message] = batch.messages;
    assert.deepEqual(await context.notifyTaskCreated({
      source: batch.source,
      message,
      taskId: '5150',
      taskUrl: 'https://b24.example/company/personal/user/7/tasks/task/view/5150/',
      // Название пришло из модели по недоверенному тексту: перенос строки увёл бы
      // ссылку вниз, поэтому в ответ бота оно едет одной строкой.
      title: 'Починить выгрузку\nостатков',
    }), { enabled: true, sent: true });
  } finally { await context.release(); }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, TOKEN);
  assert.equal(calls[0].method, 'sendMessage');
  // Ровно один вызов без retries: повтор ответа означал бы дубль в чужом чате
  // (idempotency key Bot API не даёт). Единственный рычаг против моргнувшей
  // сети здесь — дать первой попытке дойти, поэтому таймаут клиентский.
  assert.deepEqual(calls[0].options, { timeoutMs: 15_000 });
  assert.deepEqual(calls[0].body, {
    chat_id: CHAT,
    text: 'Задача #5150 поставлена в Битрикс24.\n'
      + '«Починить выгрузку остатков»\n'
      + 'https://b24.example/company/personal/user/7/tasks/task/view/5150/',
    link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: 100, allow_sending_without_reply: true },
    message_thread_id: THREAD,
  });
  assert.equal(Object.hasOwn(calls[0].body, 'parse_mode'), false);
});

test('выключенное правило молчит, а forged target не превращается в адрес отправки', async () => {
  const calls = [];
  const { capability } = harness({
    botApi: {
      async getFile() {},
      async downloadFile() {},
      async callBotApi(...args) { calls.push(args); },
    },
  });
  const context = await capability.acquireInboxContext();
  try {
    const [batch] = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000,
      limit: 10,
      activationWindows: windows(),
    });
    const [message] = batch.messages;
    assert.deepEqual(await context.notifyTaskCreated({
      source: batch.source,
      message,
      taskId: '5150',
      taskUrl: 'https://b24.example/tasks/5150',
    }), { enabled: false, sent: false });
    await assert.rejects(
      () => context.notifyTaskCreated({
        source: { ...batch.source, id: '-1009999999999' },
        message,
        taskId: '5150',
        taskUrl: 'https://b24.example/tasks/5150',
      }),
      (error) => error.code === 'telegram_inbox_invalid_notification',
    );
    await assert.rejects(
      () => context.notifyTaskCreated({
        source: { ...batch.source, threadId: '999' },
        message: { ...message, source: { ...message.source, threadId: '999' } },
        taskId: '5150',
        taskUrl: 'https://b24.example/tasks/5150',
      }),
      (error) => error.code === 'telegram_inbox_invalid_notification',
    );
  } finally { await context.release(); }
  assert.equal(calls.length, 0);
});

test('безопасность ссылки проверяется повторно, а выключенный plugin не ходит в сеть', async () => {
  const calls = [];
  let enabled = true;
  const { capability } = harness({
    pluginEnabled: () => enabled,
    channelRules: [defaultRule({ notifyTaskCreated: true })],
    botApi: {
      async getFile() {},
      async downloadFile() {},
      async callBotApi(_token, _method, body) { calls.push(body); },
    },
  });
  const context = await capability.acquireInboxContext();
  try {
    const [batch] = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000,
      limit: 10,
      activationWindows: windows(),
    });
    const [message] = batch.messages;
    await context.notifyTaskCreated({
      source: batch.source,
      message,
      taskId: '5150',
      taskUrl: 'javascript:alert(1)',
    });
    assert.equal(calls[0].text, 'Задача #5150 поставлена в Битрикс24.');

    // Название — строка-опознаватель, а не пересказ постановки: длинное режется,
    // номер задачи в ответе остаётся всегда.
    await context.notifyTaskCreated({
      source: batch.source,
      message,
      taskId: '5150',
      taskUrl: '',
      title: 'а'.repeat(4_000),
    });
    const [head, second] = calls[1].text.split('\n');
    assert.equal(head, 'Задача #5150 поставлена в Битрикс24.');
    assert.equal(second, `«${'а'.repeat(199)}…»`);

    enabled = false;
    assert.deepEqual(await context.notifyTaskCreated({
      source: batch.source,
      message,
      taskId: '5151',
      taskUrl: 'https://b24.example/tasks/5151',
    }), { enabled: true, sent: false, reason: 'plugin_disabled' });
  } finally { await context.release(); }
  assert.equal(calls.length, 2, 'выключенный plugin в сеть не ходил');
});

test('пустой allowlist не читает ни archive positions, ни native text', async () => {
  const { capability, counters } = harness({
    channelRules: [],
    onPositions() { throw new Error('archive metadata не должен читаться'); },
    onRead() { throw new Error('archive text не должен читаться'); },
  });
  const context = await capability.acquireInboxContext();
  try {
    assert.deepEqual(await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000,
      limit: 100,
      activationWindows: windows(),
    }), []);
    assert.equal(counters.rules, 1);
    assert.equal(counters.positions, 0);
    assert.equal(counters.read, 0);
  } finally { await context.release(); }
});

test('username allowlist проверяется по metadata до чтения text', async () => {
  let rulesRead = false;
  const snapshot = nativeMessage({ chatUsername: 'supportchat' });
  const { capability } = harness({
    snapshots: [snapshot],
    channelRules: [defaultRule({ chatId: null, username: 'supportchat' })],
    onRules() { rulesRead = true; },
    onRead() { assert.equal(rulesRead, true); },
  });
  const context = await capability.acquireInboxContext();
  try {
    assert.equal((await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000, limit: 10, activationWindows: windows(),
    })).length, 1);
  } finally { await context.release(); }
});

test('scan budget больше public max исчерпывающе page-ит Telegram archive', async () => {
  const snapshots = Array.from({ length: 1001 }, (_, index) => nativeMessage({
    messageId: 10_000 + index,
  }));
  const { capability, counters } = harness({ snapshots });
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000,
      limit: 10_000,
      activationWindows: windows(),
    });
    assert.equal(batches.length, 1001);
    assert.equal(batches.some((entry) => entry.truncated), false);
    assert.equal(counters.positions, 2);
    assert.equal(counters.read, 1001);
  } finally {
    await context.release();
  }
});

test('activation intervals сохраняют same-second append и исключают seq boundary, late delivery и gap', async () => {
  const specs = [
    [10, 100], [11, 100], [12, 101], [21, 201], [31, 150], [32, 301],
  ];
  const snapshots = specs.map(([seq, date]) => nativeMessage({ messageId: seq, date }));
  const positions = snapshots.map((snapshot, index) => position(snapshot, specs[index][0]));
  const activationWindows = [
    { epoch: 1, startMarker: marker(10, 100), endMarker: marker(20, 200) },
    { epoch: 2, startMarker: marker(30, 300), endMarker: null },
  ];
  const { capability } = harness({ snapshots, positions });
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: 1_000_000,
      limit: 100,
      activationWindows,
    });
    assert.deepEqual(batches.map((batch) => [batch.messages[0].id, batch.activationEpoch]), [
      ['11', 1], ['12', 1], ['32', 2],
    ]);
  } finally { await context.release(); }
});

test('marker приходит из account context callback под двумя generation checks', async () => {
  const { capability, counters } = harness();
  const context = await capability.acquireInboxContext();
  try {
    assert.deepEqual(await context.createActivationMarker({ nowMs: 12_999 }), marker(1, 12));
    assert.equal(counters.marker, 1);
  } finally { await context.release(); }
});

test('общий bundler склеивает тему целиком и режет gap ровно 600 секунд', async () => {
  const snapshots = [
    nativeMessage({ messageId: 100, date: T0 }),
    nativeMessage({
      messageId: 101, date: T0 + 10, replyToMessageId: 100,
      from: { id: 99, name: 'Борис', username: 'boris' },
    }),
    nativeMessage({ messageId: 102, date: T0 + 610 }),
    nativeMessage({
      messageId: 103, date: T0 + 700, mediaGroupId: 'album-1',
      from: { id: 7, name: 'Вера', username: 'vera' },
    }),
    nativeMessage({
      messageId: 104, date: T0 + 701, mediaGroupId: 'album-1',
      from: { id: 8, name: 'Глеб', username: 'gleb' },
    }),
  ];
  const { capability } = harness({ snapshots });
  const coordinator = new InboxCoordinator({ channels: [capability] });
  const result = await coordinator.list({ nowMs: (T0 + 2000) * 1000 });
  // Нативные ID наружу не идут, поэтому связки опознаются по времени сообщений.
  const sets = result.items.map((item) => item.messages.map((message) => message.occurredAt - T0));
  // Разные авторы, reply и части альбома лежат в одном месте, поэтому едут одной
  // карточкой; отдельным обращением стало только то, что отделено 600 секундами тишины.
  assert.deepEqual(sets, [[610, 700, 701], [0, 10]]);
});

test('materialize соблюдает Bot API limit, продолжает после ошибок и чистит token', async () => {
  const snapshot = nativeMessage({
    media: [
      { kind: 'video', fileId: 'known-big', uniqueId: 'u-big', name: 'big.mp4', size: FILE_LIMIT + 1 },
      { kind: 'document', fileId: 'late-big', uniqueId: 'u-late', name: 'late.bin', size: null },
      { kind: 'document', fileId: 'bad', uniqueId: 'u-bad', name: 'bad.txt', size: 10 },
      { kind: 'document', fileId: 'good', uniqueId: 'u-good', name: 'report', size: 10 },
    ],
  });
  const calls = { get: [], download: [], retries: [] };
  const botApi = {
    async getFile(token, fileId, opts) {
      assert.equal(token, TOKEN);
      calls.get.push(fileId);
      calls.retries.push(opts?.retries);
      if (fileId === 'late-big') return { fileId, filePath: 'files/late.bin', size: FILE_LIMIT + 1 };
      return { fileId, filePath: `files/${fileId}.csv`, size: 10 };
    },
    async downloadFile(token, filePath, opts) {
      assert.equal(token, TOKEN);
      calls.download.push(filePath);
      calls.retries.push(opts?.retries);
      if (filePath.includes('bad')) throw new Error(`скачивание ${TOKEN} оборвалось`);
      return Buffer.from('готово');
    },
  };
  const { capability } = harness({ snapshots: [snapshot], botApi });
  const context = await capability.acquireInboxContext();
  try {
    const [batch] = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000, limit: 10, activationWindows: windows(),
    });
    const attachments = batch.messages[0].attachments.map((attachment) => ({
      ...attachment,
      messageId: batch.messages[0].id,
      groupId: batch.messages[0].groupId,
    }));
    const materialized = await context.materializeAttachments(attachments);
    assert.deepEqual(calls.get, ['late-big', 'bad', 'good']);
    assert.deepEqual(calls.download, ['files/bad.csv', 'files/good.csv']);
    // Скачивание идемпотентно, поэтому моргнувшая сеть не обязана превращаться
    // в «поясните, что на фото»: право на повтор выдаёт канал каждому вызову.
    assert.ok(calls.retries.every((value) => value === 2), 'каждый файловый вызов идёт с retries');
    assert.deepEqual(materialized.files, [{
      index: 3,
      buffer: Buffer.from('готово'),
      name: 'report.csv',
      kind: 'document',
      displayLabel: 'файл',
      size: Buffer.byteLength('готово'),
    }]);
    assert.equal(materialized.skipped.length, 3);
    assert.equal(JSON.stringify(materialized).includes(TOKEN), false);
    // Причина — машинный код, а не фраза: свободный текст ошибки провайдера
    // может нести токен, а человеческую формулировку собирает сам кокпит.
    assert.equal(materialized.skipped[0].reason, 'file_too_large');
    assert.equal(materialized.skipped[0].limitBytes, FILE_LIMIT);
    assert.ok(Number.isSafeInteger(materialized.skipped[0].sizeBytes));
  } finally { await context.release(); }
});

test('повторно присланный Telegram file авторизуется для точного сообщения', async () => {
  const sharedMedia = [{
    kind: 'document', fileId: 'same-file', uniqueId: 'same-unique', name: 'same.txt', size: 1,
  }];
  const snapshots = [
    nativeMessage({ messageId: 100, date: T0, media: sharedMedia }),
    nativeMessage({ messageId: 101, date: T0 + 1, media: sharedMedia }),
  ];
  const { capability } = harness({ snapshots });
  const context = await capability.acquireInboxContext();
  try {
    const batches = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000,
      limit: 10,
      activationWindows: windows(),
    });
    const second = batches.find((batch) => batch.messages[0].id === '101').messages[0];
    const attachment = {
      ...second.attachments[0],
      messageId: second.id,
      groupId: second.groupId,
    };
    const result = await context.materializeAttachments([attachment]);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].index, 0);
    assert.deepEqual(result.skipped, []);
  } finally { await context.release(); }
});

test('materialize не вызывает Bot API для вложений после двенадцатого', async () => {
  const media = Array.from({ length: MAX_MATERIALIZED_ATTACHMENTS + 2 }, (_, index) => ({
    kind: 'document',
    fileId: `file-${index + 1}`,
    uniqueId: `unique-${index + 1}`,
    name: `file-${index + 1}.txt`,
    size: 1,
  }));
  const calls = { get: [], download: [] };
  const { capability } = harness({
    snapshots: [nativeMessage({ media })],
    botApi: {
      async getFile(_token, fileId) {
        calls.get.push(fileId);
        return { fileId, filePath: `files/${fileId}.txt`, size: 1 };
      },
      async downloadFile(_token, filePath) {
        calls.download.push(filePath);
        return Buffer.from('x');
      },
    },
  });
  const context = await capability.acquireInboxContext();
  try {
    const [batch] = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000, limit: 10, activationWindows: windows(),
    });
    const attachments = batch.messages[0].attachments.map((attachment) => ({
      ...attachment,
      messageId: batch.messages[0].id,
      groupId: batch.messages[0].groupId,
    }));
    const materialized = await context.materializeAttachments(attachments);
    assert.equal(calls.get.length, MAX_MATERIALIZED_ATTACHMENTS);
    assert.equal(calls.download.length, MAX_MATERIALIZED_ATTACHMENTS);
    assert.equal(materialized.files.length, MAX_MATERIALIZED_ATTACHMENTS);
    assert.deepEqual(
      materialized.skipped.map(({ reason }) => reason),
      ['too_many_attachments', 'too_many_attachments'],
    );
  } finally { await context.release(); }
});

test('materialize ограничивает общий размер 80 МБ до скачивания следующего файла', async () => {
  const media = Array.from({ length: 5 }, (_, index) => ({
    kind: 'video',
    fileId: `video-${index + 1}`,
    uniqueId: `video-unique-${index + 1}`,
    name: `video-${index + 1}.mp4`,
    size: null,
  }));
  const calls = { get: [], download: [] };
  const downloadLimits = [];
  const { capability } = harness({
    snapshots: [nativeMessage({ media })],
    botApi: {
      async getFile(_token, fileId) {
        calls.get.push(fileId);
        return {
          fileId,
          filePath: `files/${fileId}.mp4`,
          size: FILE_LIMIT,
        };
      },
      async downloadFile(_token, filePath, opts) {
        calls.download.push(filePath);
        downloadLimits.push(opts.limit);
        return Buffer.from('x');
      },
    },
  });
  const context = await capability.acquireInboxContext();
  try {
    const [batch] = await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000, limit: 10, activationWindows: windows(),
    });
    const attachments = batch.messages[0].attachments.map((attachment) => ({
      ...attachment,
      messageId: batch.messages[0].id,
      groupId: batch.messages[0].groupId,
    }));
    const materialized = await context.materializeAttachments(attachments);
    assert.equal(MAX_MATERIALIZED_BYTES, FILE_LIMIT * 4);
    assert.deepEqual(calls.get, ['video-1', 'video-2', 'video-3', 'video-4']);
    assert.deepEqual(calls.download, [
      'files/video-1.mp4',
      'files/video-2.mp4',
      'files/video-3.mp4',
      'files/video-4.mp4',
    ]);
    assert.deepEqual(downloadLimits, [FILE_LIMIT, FILE_LIMIT, FILE_LIMIT, FILE_LIMIT]);
    assert.equal(materialized.files.length, 4);
    assert.deepEqual(materialized.skipped.map(({ reason }) => reason), [
      'attachments_too_large',
    ]);
  } finally { await context.release(); }
});

test('attachment вне authorized batch отвергается до Bot API', async () => {
  let calls = 0;
  const { capability } = harness({
    botApi: {
      async getFile() { calls += 1; },
      async downloadFile() { calls += 1; },
    },
  });
  const context = await capability.acquireInboxContext();
  try {
    await context.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000, limit: 10, activationWindows: windows(),
    });
    await assert.rejects(
      () => context.materializeAttachments([{
        ref: 'forged', dedupeKey: 'forged', kind: 'document', displayLabel: 'файл',
        name: '', size: null, messageId: '100', groupId: null,
      }]),
      (error) => error.code === 'telegram_inbox_invalid_attachments',
    );
    assert.equal(calls, 0);
  } finally { await context.release(); }
});

test('generation switch отбрасывает поздние archive и Bot API results', async () => {
  let live = true;
  const { capability } = harness({
    current: () => live,
    onRead() { live = false; },
  });
  const context = await capability.acquireInboxContext();
  try {
    await assert.rejects(
      () => context.listAuthorizedBatches({
        nowMs: (T0 + 1000) * 1000, limit: 10, activationWindows: windows(),
      }),
      (error) => error.code === 'stale_generation' && error.statusCode === 409,
    );
  } finally { await context.release(); }

  live = true;
  const withAttachment = nativeMessage({
    media: [{ kind: 'photo', fileId: 'photo', uniqueId: 'u-photo', size: 10 }],
  });
  const second = harness({
    snapshots: [withAttachment],
    current: () => live,
    botApi: {
      async getFile() { live = false; return { filePath: 'photo.jpg', size: 10 }; },
      async downloadFile() { throw new Error('не должен вызываться'); },
    },
  });
  const secondContext = await second.capability.acquireInboxContext();
  try {
    const [batch] = await secondContext.listAuthorizedBatches({
      nowMs: (T0 + 1000) * 1000, limit: 10, activationWindows: windows(),
    });
    const [attachment] = batch.messages[0].attachments;
    await assert.rejects(
      () => secondContext.materializeAttachments([{
        ...attachment, messageId: batch.messages[0].id, groupId: null,
      }]),
      (error) => error.code === 'stale_generation',
    );
  } finally { await secondContext.release(); }
});

test('stale generation до выдачи context освобождает lease', async () => {
  const { capability, counters } = harness({ current: () => false });
  await assert.rejects(
    () => capability.acquireInboxContext(),
    (error) => error instanceof TelegramInboxChannelError
      && error.code === 'stale_generation',
  );
  assert.equal(counters.release, 1);
});

test('disconnected selected account остаётся видимым read-only без identity/credentials', async () => {
  const { capability } = harness({
    connection: 'disconnected',
    nativeExtras: { providerToken: TOKEN, providerIdentity: [1, 'api.telegram.org', 'bot', BOT_ID] },
  });
  const coordinator = new InboxCoordinator({ channels: [capability] });
  const result = await coordinator.list({ nowMs: (T0 + 1000) * 1000 });
  assert.equal(result.items.length, 1);
  assert.equal(result.channels[0].connection, 'disconnected');
  assert.equal(result.channels[0].readOnly, true);
  for (const forbidden of [ACCOUNT_REF, BOT_ID, TOKEN, 'providerIdentity']) {
    assert.equal(JSON.stringify(result).includes(forbidden), false);
  }
});

test('flattened context не публикует bot identity, token, Bot API или native stores', async () => {
  const { capability } = harness();
  const context = await capability.acquireInboxContext();
  try {
    for (const forbidden of [
      'botId', 'credentials', 'token', 'botApi', 'archive', 'rules', 'paths', 'botSettings', 'pollState',
    ]) assert.equal(Object.hasOwn(context, forbidden), false);
  } finally { await context.release(); }
});
