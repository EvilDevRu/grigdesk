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
  code: string;

  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'InboxRefError';
    this.code = 'invalid_inbox_ref';
    this.statusCode = 400;
  }
}

export type InboxRefKind = 'message' | 'item' | 'scope';

// Поля ref одного из трёх видов. Нативные id каналов остаются строками: числовой
// id соседнего канала совпал бы со строковым, и ссылка указала бы не туда.
export interface InboxRefFields {
  channel?: unknown;
  accountRef?: unknown;
  sourceId?: unknown;
  messageId?: unknown;
  localBundleId?: unknown;
  policyScopeId?: unknown;
}

export interface DecodedInboxRef {
  version: number;
  kind: string;
  channel: string;
  accountRef: string;
  sourceId?: string;
  messageId?: string;
  localBundleId?: string;
  policyScopeId?: string;
  tuple: unknown[];
  ref?: string;
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (message: string) => never = (message) => {
  throw new InboxRefError(message);
};

export function assertChannel(value: unknown, where = 'channel'): string {
  if (typeof value !== 'string' || !CHANNEL_RE.test(value)) {
    fail(`${where}: ожидалась строка по шаблону [a-z0-9][a-z0-9_-]{0,40}.`);
  }
  return value;
}

export function assertAccountRef(value: unknown, where = 'accountRef'): string {
  if (typeof value !== 'string' || !ACCOUNT_REF_RE.test(value)) {
    fail(`${where}: ожидался безопасный server-generated ASCII id длиной до 80 символов.`);
  }
  return value;
}

export function assertNativeSegment(value: unknown, where = 'native id'): string {
  if (typeof value !== 'string') fail(`${where}: числовые и другие нестроковые id запрещены.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 1 || bytes > INBOX_REF_LIMITS.nativeSegmentBytes) {
    fail(`${where}: размер должен быть 1..${INBOX_REF_LIMITS.nativeSegmentBytes} байт UTF-8.`);
  }
  return value;
}

function tupleOf(kind: string, fields: InboxRefFields | undefined): unknown[] {
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

function fieldsOf(tuple: unknown[]): DecodedInboxRef {
  const [version, kind, channel, accountRef, first, second] = tuple as [
    number, string, string, string, string, string?,
  ];
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

export function encodeInboxRef(kind: string, fields: InboxRefFields | undefined): string {
  const tuple = tupleOf(kind, fields);
  const encoded = Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
  if (encoded.length > INBOX_REF_LIMITS.encodedChars) fail('Inbox ref превышает общий лимит 8192 символа.');
  return encoded;
}

/**
 * Декодирует ref только в ожидаемом виде. Вид обязателен: ссылка на сообщение и
 * ссылка на обращение живут в одном пространстве, и принять одну вместо другой
 * значило бы разрешить решение по чужой сущности.
 */
export function decodeInboxRef(ref: unknown, expected: {
  kind?: string;
  channel?: unknown;
  accountRef?: unknown;
} = {}): DecodedInboxRef {
  const { kind, channel, accountRef } = expected;
  if (!INBOX_REF_KINDS.includes(String(kind))) {
    fail('Decoder обязан получить конкретный ожидаемый kind.');
  }
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > INBOX_REF_LIMITS.encodedChars) {
    fail('Inbox ref должен быть непустой строкой длиной не больше 8192 символов.');
  }
  if (!BASE64URL_RE.test(ref) || ref.includes('=')) {
    fail('Inbox ref должен быть unpadded base64url без whitespace и «=».');
  }

  let json: string;
  let tuple: unknown;
  try {
    json = UTF8.decode(Buffer.from(ref, 'base64url'));
    tuple = JSON.parse(json);
  } catch {
    fail('Inbox ref не декодируется в UTF-8 JSON tuple.');
  }
  if (!Array.isArray(tuple)) fail('Inbox ref должен декодироваться в tuple.');

  const parts = tuple as unknown[];
  const expectedLength = kind === 'message' ? 6 : 5;

  if (parts.length !== expectedLength || parts[0] !== 1 || parts[1] !== kind) {
    fail(`Inbox ref не является canonical ${kind} tuple версии 1.`);
  }

  // Повторная сборка одновременно проверяет все типы/границы сегментов.
  const decoded = fieldsOf(parts);
  const canonical = encodeInboxRef(String(kind), decoded);
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
  channel: string;

  accountRef: string;

  constructor({ channel, accountRef }: { channel?: unknown; accountRef?: unknown }) {
    this.channel = assertChannel(channel);
    this.accountRef = assertAccountRef(accountRef);
  }

  message(sourceId: unknown, messageId: unknown): string {
    return encodeInboxRef('message', {
      channel: this.channel,
      accountRef: this.accountRef,
      sourceId,
      messageId,
    });
  }

  item(localBundleId: unknown): string {
    return encodeInboxRef('item', {
      channel: this.channel,
      accountRef: this.accountRef,
      localBundleId,
    });
  }

  scope(policyScopeId: unknown): string {
    return encodeInboxRef('scope', {
      channel: this.channel,
      accountRef: this.accountRef,
      policyScopeId,
    });
  }

  decode(ref: unknown, kind: string | { kind?: string }): DecodedInboxRef {
    const expectedKind = typeof kind === 'string' ? kind : kind?.kind;
    return decodeInboxRef(ref, {
      kind: expectedKind,
      channel: this.channel,
      accountRef: this.accountRef,
    });
  }
}
