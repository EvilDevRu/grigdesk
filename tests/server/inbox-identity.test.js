import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeInboxRef,
  encodeInboxRef,
  InboxRefCodec,
  InboxRefError,
} from '../../server/src/lib/inbox/identity.js';

const ACCOUNT = 'acc_identity_00000001';
const OTHER_ACCOUNT = 'acc_identity_00000002';

test('typed codec round-trip сохраняет :, #, /, Unicode и JSON escapes без concat collisions', () => {
  const codec = new InboxRefCodec({ channel: 'telegram', accountRef: ACCOUNT });
  const sourceId = 'источник:/#"\\';
  const messageId = 'сообщение:/#\n\u0000';
  const ref = codec.message(sourceId, messageId);
  assert.equal(ref.includes('='), false);
  assert.deepEqual(codec.decode(ref, 'message'), {
    version: 1,
    kind: 'message',
    channel: 'telegram',
    accountRef: ACCOUNT,
    sourceId,
    messageId,
    tuple: [1, 'message', 'telegram', ACCOUNT, sourceId, messageId],
    ref,
  });
});

test('message/item/scope refs строго типизированы', () => {
  const codec = new InboxRefCodec({ channel: 'telegram', accountRef: ACCOUNT });
  const messageRef = codec.message('source', '1');
  const itemRef = codec.item('bundle');
  const scopeRef = codec.scope('policy');

  assert.throws(() => codec.decode(messageRef, 'item'), InboxRefError);
  assert.throws(() => codec.decode(itemRef, 'message'), InboxRefError);
  assert.throws(() => codec.decode(scopeRef, 'item'), InboxRefError);
  assert.throws(() => decodeInboxRef(messageRef), /конкретный ожидаемый kind/);
});

test('owner входит в identity: одинаковые native IDs разных source/account не сталкиваются', () => {
  const first = new InboxRefCodec({ channel: 'telegram', accountRef: ACCOUNT });
  const second = new InboxRefCodec({ channel: 'telegram', accountRef: OTHER_ACCOUNT });
  const refs = new Set([
    first.message('source-a', '1'),
    first.message('source-b', '1'),
    second.message('source-a', '1'),
    encodeInboxRef('message', {
      channel: 'github', accountRef: ACCOUNT, sourceId: 'source-a', messageId: '1',
    }),
  ]);
  assert.equal(refs.size, 4);
  assert.throws(() => first.decode(second.message('source-a', '1'), 'message'), /другому accountRef/);
});

test('decoder отвергает padding, whitespace, JSON escape aliases и base64 aliases', () => {
  const codec = new InboxRefCodec({ channel: 'telegram', accountRef: ACCOUNT });
  const canonical = codec.message('source', 'a');
  assert.throws(() => codec.decode(`${canonical}=`, 'message'), /unpadded base64url/);
  assert.throws(() => codec.decode(` ${canonical}`, 'message'), /unpadded base64url/);

  const escapedJson = `[1,"message","telegram","${ACCOUNT}","source","\\u0061"]`;
  const escaped = Buffer.from(escapedJson).toString('base64url');
  assert.notEqual(escaped, canonical);
  assert.throws(() => codec.decode(escaped, 'message'), /неканоническое/);

  // Последний незначащий base64 bit Buffer декодирует permissive, re-encode обязан поймать alias.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(canonical.at(-1));
  const alias = canonical.slice(0, -1) + alphabet[(last ^ 1) & 63];
  if (Buffer.from(alias, 'base64url').equals(Buffer.from(canonical, 'base64url'))) {
    assert.throws(() => codec.decode(alias, 'message'), /неканоническое/);
  }
});

test('tuple version/length/types и все size limits fail closed', () => {
  const asRef = (tuple) => Buffer.from(JSON.stringify(tuple)).toString('base64url');
  assert.throws(() => decodeInboxRef(asRef([
    '1', 'message', 'telegram', ACCOUNT, 'source', '1',
  ]), { kind: 'message' }), /версии 1/);
  assert.throws(() => decodeInboxRef(asRef([
    1, 'message', 'telegram', ACCOUNT, 'source', 1,
  ]), { kind: 'message' }), /нестроковые id/);
  assert.throws(() => encodeInboxRef('message', {
    channel: 'Telegram', accountRef: ACCOUNT, sourceId: 's', messageId: '1',
  }), /шаблону/);
  assert.throws(() => encodeInboxRef('message', {
    channel: 'telegram', accountRef: ACCOUNT, sourceId: 's', messageId: 'я'.repeat(1025),
  }), /2048 байт/);
  assert.throws(() => new InboxRefCodec({ channel: 'telegram', accountRef: `a${'x'.repeat(80)}` }), /до 80/);
});
