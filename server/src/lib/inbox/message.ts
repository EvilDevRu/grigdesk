// Доверенная граница общего Inbox.
//
// Канал сначала преобразует свою нативную запись в этот контракт, а затем передаёт
// результат сюда вместе с ожидаемыми channel/accountRef. Валидатор намеренно ничего
// не дополняет и не приводит к строкам: числовой provider id, забытый null или лишнее
// нативное поле означают ошибку adapter-а, а не повод угадать формат.

import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import { assertAccountRef, assertChannel, assertNativeSegment } from './identity.ts';

const TOP_LEVEL_KEYS = [
  'schema',
  'channel',
  'accountRef',
  'source',
  'id',
  'parentId',
  'groupId',
  'occurredAt',
  'editedAt',
  'author',
  'text',
  'attachments',
  'service',
];
const SOURCE_KEYS = ['id', 'title', 'threadId'];
const AUTHOR_KEYS = ['id', 'name'];
const ATTACHMENT_KEYS = ['ref', 'dedupeKey', 'kind', 'displayLabel', 'name', 'size'];

export const INBOX_MESSAGE_LIMITS = Object.freeze({
  sourceTitleBytes: 4096,
  authorNameBytes: 1024,
  textBytes: 1024 * 1024,
  attachments: 100,
  attachmentOpaqueBytes: 8192,
  attachmentKindBytes: 80,
  attachmentLabelBytes: 1024,
  attachmentNameBytes: 4096,
});

export class InboxMessageValidationError extends Error {
  code: string;

  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'InboxMessageValidationError';
    this.code = 'invalid_inbox_message';
    this.statusCode = 400;
  }
}

type Payload = Record<string, unknown>;

export interface InboxAttachmentRecord {
  ref: string;
  dedupeKey: string;
  kind: string;
  displayLabel: string;
  name: string;
  size: number | null;
}

// Нормализованное сообщение общего Inbox. Канал приводит к нему свою запись, а
// доверенные channel и accountRef приходят снаружи: провайдер их не назначает.
export interface InboxMessageRecord {
  schema: 1;
  channel: string;
  accountRef: string;
  source: {
    id: string;
    title: string;
    threadId: string | null;
  };
  id: string;
  parentId: string | null;
  groupId: string | null;
  occurredAt: number;
  editedAt: number | null;
  author: {
    id: string | null;
    name: string;
  };
  text: string;
  attachments: InboxAttachmentRecord[];
  service: boolean;
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (message: string) => never = (message) => {
  throw new InboxMessageValidationError(message);
};

function assertExactObject(value: unknown, keys: string[], where: string): void {
  if (!isPlainRecord(value)) fail(`${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, i) => key !== expected[i])) {
    fail(`${where}: поля должны в точности совпадать с контрактом (${keys.join(', ')}).`);
  }
}

function assertString(
  value: unknown,
  where: string,
  { minBytes = 0, maxBytes }: { minBytes?: number; maxBytes: number },
): string {
  if (typeof value !== 'string') fail(`${where}: ожидалась строка.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minBytes || bytes > maxBytes) {
    fail(`${where}: размер строки должен быть ${minBytes}..${maxBytes} байт UTF-8.`);
  }
  return value;
}

function assertIdentifier(
  value: unknown,
  where: string,
  { nullable = false }: { nullable?: boolean } = {},
): string | null {
  if (nullable && value === null) return null;

  try {
    return assertNativeSegment(value, where);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function assertUnixSeconds(
  value: unknown,
  where: string,
  { nullable = false }: { nullable?: boolean } = {},
): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${where}: ожидались неотрицательные Unix seconds в safe integer.`);
  }
  return value;
}

function validateAttachment(source: unknown, index: number): InboxAttachmentRecord {
  const where = `attachments[${index}]`;

  assertExactObject(source, ATTACHMENT_KEYS, where);

  const raw = source as Payload;
  const limits = INBOX_MESSAGE_LIMITS;

  const ref = assertString(raw.ref, `${where}.ref`, {
    minBytes: 1,
    maxBytes: limits.attachmentOpaqueBytes,
  });
  const dedupeKey = assertString(raw.dedupeKey, `${where}.dedupeKey`, {
    minBytes: 1,
    maxBytes: limits.attachmentOpaqueBytes,
  });
  const kind = assertString(raw.kind, `${where}.kind`, {
    minBytes: 1,
    maxBytes: limits.attachmentKindBytes,
  });
  const displayLabel = assertString(raw.displayLabel, `${where}.displayLabel`, {
    maxBytes: limits.attachmentLabelBytes,
  });
  const name = assertString(raw.name, `${where}.name`, {
    maxBytes: limits.attachmentNameBytes,
  });
  if (raw.size !== null
      && (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0)) {
    fail(`${where}.size: ожидался null или неотрицательный safe integer.`);
  }

  return {
    ref,
    dedupeKey,
    kind,
    displayLabel,
    name,
    size: raw.size as number | null,
  };
}

/**
 * Проверяет и копирует нормализованное сообщение Inbox v1.
 *
 * `activationEpoch` сюда не входит: это server-only метка конкретного чтения archive,
 * которую bundler принимает отдельной оболочкой `{message, activationEpoch}`.
 */
export function validateInboxMessage(source: unknown, { expectedChannel, expectedAccountRef }: {
  expectedChannel?: unknown;
  expectedAccountRef?: unknown;
} = {}): InboxMessageRecord {
  if (expectedChannel === undefined || expectedAccountRef === undefined) {
    fail('Validator обязан получить expectedChannel и expectedAccountRef от server composition.');
  }
  try {
    assertChannel(expectedChannel);
    assertAccountRef(expectedAccountRef);
  } catch (err) {
    fail(`Ожидаемый owner невалиден: ${err instanceof Error ? err.message : String(err)}`);
  }

  assertExactObject(source, TOP_LEVEL_KEYS, 'InboxMessage');

  const raw = source as Payload;
  if (raw.schema !== 1) fail('InboxMessage.schema: поддерживается только версия 1.');
  if (raw.channel !== expectedChannel) {
    fail(`InboxMessage.channel: ожидался доверенный канал «${expectedChannel}».`);
  }
  if (raw.accountRef !== expectedAccountRef) {
    fail('InboxMessage.accountRef не совпадает с доверенным account context.');
  }

  assertExactObject(raw.source, SOURCE_KEYS, 'InboxMessage.source');
  assertExactObject(raw.author, AUTHOR_KEYS, 'InboxMessage.author');

  const rawSource = raw.source as Payload;
  const rawAuthor = raw.author as Payload;
  if (!Array.isArray(raw.attachments)) fail('InboxMessage.attachments: ожидался массив.');
  if ((raw.attachments as unknown[]).length > INBOX_MESSAGE_LIMITS.attachments) {
    fail(`InboxMessage.attachments: допускается не больше ${INBOX_MESSAGE_LIMITS.attachments} вложений.`);
  }
  if (typeof raw.service !== 'boolean') fail('InboxMessage.service: ожидался boolean.');

  const messageSource = {
    id: assertIdentifier(rawSource.id, 'InboxMessage.source.id') as string,
    title: assertString(rawSource.title, 'InboxMessage.source.title', {
      maxBytes: INBOX_MESSAGE_LIMITS.sourceTitleBytes,
    }),
    threadId: assertIdentifier(
      rawSource.threadId,
      'InboxMessage.source.threadId',
      { nullable: true },
    ),
  };
  const author = {
    id: assertIdentifier(rawAuthor.id, 'InboxMessage.author.id', { nullable: true }),
    name: assertString(rawAuthor.name, 'InboxMessage.author.name', {
      maxBytes: INBOX_MESSAGE_LIMITS.authorNameBytes,
    }),
  };

  return {
    schema: 1,
    channel: raw.channel as string,
    accountRef: raw.accountRef as string,
    source: messageSource,
    id: assertIdentifier(raw.id, 'InboxMessage.id') as string,
    parentId: assertIdentifier(raw.parentId, 'InboxMessage.parentId', { nullable: true }),
    groupId: assertIdentifier(raw.groupId, 'InboxMessage.groupId', { nullable: true }),
    occurredAt: assertUnixSeconds(raw.occurredAt, 'InboxMessage.occurredAt') as number,
    editedAt: assertUnixSeconds(raw.editedAt, 'InboxMessage.editedAt', { nullable: true }),
    author,
    text: assertString(raw.text, 'InboxMessage.text', {
      maxBytes: INBOX_MESSAGE_LIMITS.textBytes,
    }),
    attachments: (raw.attachments as unknown[]).map(validateAttachment),
    service: raw.service as boolean,
  };
}
