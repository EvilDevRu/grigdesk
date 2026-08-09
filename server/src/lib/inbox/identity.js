// Единственный codec внешних Inbox refs.
//
// Нативные id могут содержать `:`, `#`, `/`, Unicode и любые JSON escapes, поэтому
// их нельзя склеивать разделителями. Versioned tuple сериализуется ровно одним
// JSON.stringify и выдаётся как unpadded base64url; decoder принимает только этот
// канонический байтовый вид и всегда требует ожидаемый kind.

import { TextDecoder } from 'node:util';

export const INBOX_REF_KINDS = Object.freeze(['message', 'item', 'scope']);
export const INBOX_REF_LIMITS = Object.freeze({
  encodedChars: 8192,
  nativeSegmentBytes: 2048,
  accountRefChars: 80,
});

export const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const ACCOUNT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export class InboxRefError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxRefError';
    this.code = 'invalid_inbox_ref';
    this.statusCode = 400;
  }
}

const fail = (message) => {
  throw new InboxRefError(message);
};

export function assertChannel(value, where = 'channel') {
  if (typeof value !== 'string' || !CHANNEL_RE.test(value)) {
    fail(`${where}: ожидалась строка по шаблону [a-z0-9][a-z0-9_-]{0,40}.`);
  }
  return value;
}

export function assertAccountRef(value, where = 'accountRef') {
  if (typeof value !== 'string' || !ACCOUNT_REF_RE.test(value)) {
    fail(`${where}: ожидался безопасный server-generated ASCII id длиной до 80 символов.`);
  }
  return value;
}

export function assertNativeSegment(value, where = 'native id') {
  if (typeof value !== 'string') fail(`${where}: числовые и другие нестроковые id запрещены.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > INBOX_REF_LIMITS.nativeSegmentBytes) {
    fail(`${where}: размер должен быть 1..${INBOX_REF_LIMITS.nativeSegmentBytes} байт UTF-8.`);
  }
  return value;
}

function tupleOf(kind, fields) {
  if (!INBOX_REF_KINDS.includes(kind)) fail(`Неизвестный kind Inbox ref: «${kind}».`);
  const channel = assertChannel(fields?.channel);
  const accountRef = assertAccountRef(fields?.accountRef);
  if (kind === 'message') {
    return [
      1,
      kind,
      channel,
      accountRef,
      assertNativeSegment(fields?.sourceId, 'sourceId'),
      assertNativeSegment(fields?.messageId, 'messageId'),
    ];
  }
  const name = kind === 'item' ? 'localBundleId' : 'policyScopeId';
  return [1, kind, channel, accountRef, assertNativeSegment(fields?.[name], name)];
}

function fieldsOf(tuple) {
  const [version, kind, channel, accountRef, first, second] = tuple;
  if (kind === 'message') {
    return {
      version,
      kind,
      channel,
      accountRef,
      sourceId: first,
      messageId: second,
      tuple: [...tuple],
    };
  }
  return {
    version,
    kind,
    channel,
    accountRef,
    [kind === 'item' ? 'localBundleId' : 'policyScopeId']: first,
    tuple: [...tuple],
  };
}

export function encodeInboxRef(kind, fields) {
  const tuple = tupleOf(kind, fields);
  const encoded = Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
  if (encoded.length > INBOX_REF_LIMITS.encodedChars) fail('Inbox ref превышает общий лимит 8192 символа.');
  return encoded;
}

/**
 * Декодирует ref только в ожидаемом поле.
 *
 * @param {string} ref unpadded base64url
 * @param {{kind: 'message'|'item'|'scope', channel?: string, accountRef?: string}} expected
 */
export function decodeInboxRef(ref, expected = {}) {
  const { kind, channel, accountRef } = expected;
  if (!INBOX_REF_KINDS.includes(kind)) fail('Decoder обязан получить конкретный ожидаемый kind.');
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > INBOX_REF_LIMITS.encodedChars) {
    fail('Inbox ref должен быть непустой строкой длиной не больше 8192 символов.');
  }
  if (!BASE64URL_RE.test(ref) || ref.includes('=')) {
    fail('Inbox ref должен быть unpadded base64url без whitespace и «=».');
  }

  let json;
  let tuple;
  try {
    json = UTF8.decode(Buffer.from(ref, 'base64url'));
    tuple = JSON.parse(json);
  } catch {
    fail('Inbox ref не декодируется в UTF-8 JSON tuple.');
  }
  if (!Array.isArray(tuple)) fail('Inbox ref должен декодироваться в tuple.');
  const expectedLength = kind === 'message' ? 6 : 5;
  if (tuple.length !== expectedLength || tuple[0] !== 1 || tuple[1] !== kind) {
    fail(`Inbox ref не является canonical ${kind} tuple версии 1.`);
  }

  // Повторная сборка одновременно проверяет все типы/границы сегментов.
  const decoded = fieldsOf(tuple);
  const canonical = encodeInboxRef(kind, decoded);
  if (canonical !== ref) fail('Inbox ref имеет неканоническое base64url/JSON представление.');
  if (channel !== undefined && decoded.channel !== assertChannel(channel, 'expected channel')) {
    fail('Inbox ref принадлежит другому channel.');
  }
  if (accountRef !== undefined && decoded.accountRef !== assertAccountRef(accountRef, 'expected accountRef')) {
    fail('Inbox ref принадлежит другому accountRef.');
  }
  return { ...decoded, ref: canonical };
}

/** Codec, привязанный к одной доверенной паре channel + accountRef. */
export class InboxRefCodec {
  constructor({ channel, accountRef }) {
    this.channel = assertChannel(channel);
    this.accountRef = assertAccountRef(accountRef);
  }

  message(sourceId, messageId) {
    return encodeInboxRef('message', {
      channel: this.channel,
      accountRef: this.accountRef,
      sourceId,
      messageId,
    });
  }

  item(localBundleId) {
    return encodeInboxRef('item', {
      channel: this.channel,
      accountRef: this.accountRef,
      localBundleId,
    });
  }

  scope(policyScopeId) {
    return encodeInboxRef('scope', {
      channel: this.channel,
      accountRef: this.accountRef,
      policyScopeId,
    });
  }

  decode(ref, kind) {
    const expectedKind = typeof kind === 'string' ? kind : kind?.kind;
    return decodeInboxRef(ref, {
      kind: expectedKind,
      channel: this.channel,
      accountRef: this.accountRef,
    });
  }
}
