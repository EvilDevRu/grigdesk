import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bundleInboxMessages,
  InboxBundleError,
  validateInboxGrouping,
} from '../../server/src/lib/inbox/bundle.js';

const ACCOUNT = 'acc_bundle_000000001';
const message = (over = {}) => ({
  schema: 1,
  channel: 'telegram',
  accountRef: ACCOUNT,
  source: { id: 'chat-a', title: 'Баги', threadId: 'topic-a' },
  id: '1',
  parentId: null,
  groupId: null,
  occurredAt: 1000,
  editedAt: null,
  author: { id: 'author-a', name: 'Имя' },
  text: 'текст',
  attachments: [],
  service: false,
  ...over,
});
const entry = (over = {}, activationEpoch = 1) => ({ message: message(over), activationEpoch });

test('channel defaults: Telegram 600 секунд, GitHub Issues 0', () => {
  assert.deepEqual(validateInboxGrouping('telegram'), { settleMs: 600_000, bundleKeyOf: null });
  assert.deepEqual(validateInboxGrouping('github'), { settleMs: 0, bundleKeyOf: null });
  assert.throws(() => validateInboxGrouping('custom'), InboxBundleError);
});

test('Telegram склеивает по теме до точной границы 600 секунд и split на границе', () => {
  const bundles = bundleInboxMessages([
    entry({ id: '1', occurredAt: 1000 }),
    entry({ id: '2', occurredAt: 1599 }),
    entry({ id: '3', occurredAt: 2199 }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 2_799_000 });

  assert.equal(bundles.length, 2);
  assert.deepEqual(bundles.map((bundle) => bundle.messages.map((msg) => msg.id)), [['3'], ['1', '2']]);
  assert.equal(bundles[0].settled, true);
  assert.equal(bundles[1].settled, true);
});

test('соседи по теме склеиваются независимо от автора', () => {
  // Живой случай: просьба и уточнение соседа через 40 секунд в одной теме форума
  // разъезжались на две карточки и давали две задачи, потому что ключ нёс автора.
  const bundles = bundleInboxMessages([
    entry({ id: '20654', occurredAt: 1000, author: { id: 'arsenkin', name: 'Александр' } }),
    entry({ id: '20655', occurredAt: 1040, author: { id: 'dmitriy', name: 'Dmitriy' } }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_640_000 });

  assert.equal(bundles.length, 1);
  assert.deepEqual(bundles[0].messages.map((msg) => msg.id), ['20654', '20655']);
});

test('соседние темы одного чата остаются разными обращениями', () => {
  const bundles = bundleInboxMessages([
    entry({ id: 'a', occurredAt: 1000, source: { id: 'chat-a', title: 'Баги', threadId: 'topic-a' } }),
    entry({ id: 'b', occurredAt: 1005, source: { id: 'chat-a', title: 'Релизы', threadId: 'topic-b' } }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_605_000 });

  assert.deepEqual(bundles.map((bundle) => bundle.messages.map((msg) => msg.id)), [['b'], ['a']]);
});

test('reply и альбом остаются в связке своего места, а не рвут её', () => {
  // Своя ветка у media group ОТРЫВАЛА альбом от текста, отправленного рядом; своя ветка
  // у reply отменяла склейку места. Оба повода лежат в одной теме — склеивает место.
  const bundles = bundleInboxMessages([
    entry({ id: 'root', author: { id: 'a', name: 'A' } }),
    entry({ id: 'reply', parentId: 'root', occurredAt: 1010, author: { id: 'b', name: 'B' } }),
    entry({ id: 'nested', parentId: 'reply', occurredAt: 1020, author: { id: 'c', name: 'C' } }),
    entry({ id: 'album-1', groupId: 'album', occurredAt: 1030, author: { id: null, name: '' } }),
    entry({ id: 'album-2', groupId: 'album', occurredAt: 1040, author: { id: null, name: '' } }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_100_000 });

  assert.deepEqual(bundles.map((bundle) => bundle.messages.map((msg) => msg.id)), [
    ['root', 'reply', 'nested', 'album-1', 'album-2'],
  ]);
});

test('ответы на РАЗНЫЕ сообщения вне очереди склеиваются по месту', () => {
  // Живой случай: три подряд идущих сообщения одного человека, каждое — reply на своё
  // сообщение старше activation. Пока reply имел свою ветку ключа, она была уникальна
  // у каждого: одна просьба разъезжалась на три карточки и три отдельные задачи.
  const bundles = bundleInboxMessages([
    entry({ id: '20442', parentId: '20300', occurredAt: 1000 }),
    entry({ id: '20443', parentId: '20301', occurredAt: 1013 }),
    entry({ id: '20444', parentId: '20302', occurredAt: 1020 }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_620_000 });

  assert.equal(bundles.length, 1);
  assert.deepEqual(bundles[0].messages.map((msg) => msg.id), ['20442', '20443', '20444']);
});

test('ответы на ОСТЫВШИЕ связки очереди тоже склеиваются по месту', () => {
  // Вторая половина того же живого случая: родители ЕСТЬ в очереди (activation window
  // держит их днями), но их связки давно остыли. Per-parent ключ изолировал каждый reply
  // в свою карточку и вдобавок отрывал их от обычных сообщений рядом.
  const bundles = bundleInboxMessages([
    entry({ id: 'old-1', occurredAt: 1000 }),
    entry({ id: 'old-2', occurredAt: 1005 }),
    entry({ id: 'reply-1', parentId: 'old-1', occurredAt: 51_000 }),
    entry({ id: 'reply-2', parentId: 'old-2', occurredAt: 51_010 }),
    entry({ id: 'plain', occurredAt: 51_020 }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 52_000_000 });

  assert.deepEqual(bundles.map((bundle) => bundle.messages.map((msg) => msg.id)), [
    ['reply-1', 'reply-2', 'plain'],
    ['old-1', 'old-2'],
  ]);
});

test('reply не воскрешает разобранный разговор через окно тишины', () => {
  // Обратная сторона склейки по месту: ответ на давнее сообщение обязан начать НОВОЕ
  // обращение. Иначе реплай на строку недельной давности дописывал бы сообщение в уже
  // решённую человеком карточку.
  const bundles = bundleInboxMessages([
    entry({ id: 'root', occurredAt: 1000 }),
    entry({ id: 'reply', parentId: 'root', occurredAt: 51_000 }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 51_600_000 });

  assert.deepEqual(bundles.map((bundle) => bundle.messages.map((msg) => msg.id)), [
    ['reply'],
    ['root'],
  ]);
});

test('source.id и activationEpoch namespaced: одинаковые IDs не пересекаются', () => {
  const bundles = bundleInboxMessages([
    entry({ id: 'same', source: { id: 'a', title: '', threadId: null } }, 1),
    entry({ id: 'same', source: { id: 'b', title: '', threadId: null } }, 1),
    entry({ id: 'later', source: { id: 'a', title: '', threadId: null }, occurredAt: 1001 }, 2),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_001_000 });
  assert.equal(bundles.length, 3);
  assert.deepEqual(new Set(bundles.map((bundle) => bundle.activationEpoch)), new Set([1, 2]));
  assert.equal(new Set(bundles.map((bundle) => bundle.localBundleId)).size, 3);
});

test('чат без тем склеивается целиком, service messages отбрасываются', () => {
  const plain = { id: 'chat', title: '', threadId: null };
  const bundles = bundleInboxMessages([
    entry({ id: '1', source: plain, author: { id: null, name: 'Same' } }),
    entry({ id: '2', source: plain, author: { id: 'someone', name: 'Кто-то' }, occurredAt: 1001 }),
    entry({ id: 'service', source: plain, service: true, occurredAt: 1002 }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_002_000 });
  assert.equal(bundles.length, 1);
  assert.deepEqual(bundles[0].messages.map((msg) => msg.id), ['1', '2']);
});

test('GitHub pure bundleKeyOf namespaced source и не ждёт settle window', () => {
  const githubAccount = 'acc_github_bundle_001';
  const issue = (source, id) => ({
    ...message({
      channel: 'github',
      accountRef: githubAccount,
      source: { id: source, title: 'repo', threadId: id },
      id,
      author: { id: 'user', name: 'User' },
    }),
  });
  const hook = (msg) => ({ kind: 'issue', id: msg.source.threadId });
  const bundles = bundleInboxMessages([
    { message: issue('repo-1', '42'), activationEpoch: 1 },
    { message: issue('repo-2', '42'), activationEpoch: 1 },
  ], {
    channel: 'github',
    accountRef: githubAccount,
    grouping: { bundleKeyOf: hook },
    nowMs: 1_000_000,
  });
  assert.equal(bundles.length, 2);
  assert.ok(bundles.every((bundle) => bundle.settled));
  assert.notEqual(bundles[0].groupingKey, bundles[1].groupingKey);

  assert.throws(() => bundleInboxMessages([
    { message: issue('repo-1', '42'), activationEpoch: 1 },
  ], {
    channel: 'github',
    accountRef: githubAccount,
    grouping: { bundleKeyOf: async () => 'issue' },
  }), /синхронной pure-функцией/);
});
