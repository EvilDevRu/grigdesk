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

test('Telegram склеивает по author/topic до точной границы 600 секунд и split на границе', () => {
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

test('reply chain наследует bundle родителя, groupId явно склеивает альбом', () => {
  const bundles = bundleInboxMessages([
    entry({ id: 'root', author: { id: 'a', name: 'A' } }),
    entry({ id: 'reply', parentId: 'root', occurredAt: 1010, author: { id: 'b', name: 'B' } }),
    entry({ id: 'nested', parentId: 'reply', occurredAt: 1020, author: { id: 'c', name: 'C' } }),
    entry({ id: 'album-1', groupId: 'album', occurredAt: 1030, author: { id: null, name: '' } }),
    entry({ id: 'album-2', groupId: 'album', occurredAt: 1040, author: { id: null, name: '' } }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_100_000 });

  assert.deepEqual(bundles.map((bundle) => bundle.messages.map((msg) => msg.id)), [
    ['album-1', 'album-2'],
    ['root', 'reply', 'nested'],
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

test('anonymous display name не становится identity, service messages отбрасываются', () => {
  const bundles = bundleInboxMessages([
    entry({ id: '1', source: { id: 'chat', title: '', threadId: null }, author: { id: null, name: 'Same' } }),
    entry({ id: '2', source: { id: 'chat', title: '', threadId: null }, author: { id: null, name: 'Same' }, occurredAt: 1001 }),
    entry({ id: 'service', service: true, occurredAt: 1002 }),
  ], { channel: 'telegram', accountRef: ACCOUNT, nowMs: 1_002_000 });
  assert.equal(bundles.length, 2);
  assert.equal(bundles.some((bundle) => bundle.messages.some((msg) => msg.service)), false);
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
