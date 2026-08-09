// Доверенная граница общего Inbox.
//
// Канал сначала преобразует свою нативную запись в этот контракт, а затем передаёт
// результат сюда вместе с ожидаемыми channel/accountRef. Валидатор намеренно ничего
// не дополняет и не приводит к строкам: числовой provider id, забытый null или лишнее
// нативное поле означают ошибку adapter-а, а не повод угадать формат.

import { assertAccountRef, assertChannel, assertNativeSegment } from './identity.js';

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
  constructor(message) {
    super(message);
    this.name = 'InboxMessageValidationError';
    this.code = 'invalid_inbox_message';
    this.statusCode = 400;
  }
}

const fail = (message) => {
  throw new InboxMessageValidationError(message);
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function assertExactObject(value, keys, where) {
  if (!isPlainObject(value)) fail(`${where}: ожидался объект.`);
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (own.length !== expected.length || own.some((key, i) => key !== expected[i])) {
    fail(`${where}: поля должны в точности совпадать с контрактом (${keys.join(', ')}).`);
  }
}

function assertString(value, where, { minBytes = 0, maxBytes }) {
  if (typeof value !== 'string') fail(`${where}: ожидалась строка.`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minBytes || bytes > maxBytes) {
    fail(`${where}: размер строки должен быть ${minBytes}..${maxBytes} байт UTF-8.`);
  }
  return value;
}

function assertIdentifier(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  try {
    return assertNativeSegment(value, where);
  } catch (err) {
    fail(err.message);
  }
}

function assertUnixSeconds(value, where, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${where}: ожидались неотрицательные Unix seconds в safe integer.`);
  }
  return value;
}

function validateAttachment(raw, index) {
  const where = `attachments[${index}]`;
  assertExactObject(raw, ATTACHMENT_KEYS, where);
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
  if (raw.size !== null && (!Number.isSafeInteger(raw.size) || raw.size < 0)) {
    fail(`${where}.size: ожидался null или неотрицательный safe integer.`);
  }

  return { ref, dedupeKey, kind, displayLabel, name, size: raw.size };
}

/**
 * Проверяет и копирует нормализованное сообщение Inbox v1.
 *
 * `activationEpoch` сюда не входит: это server-only метка конкретного чтения archive,
 * которую bundler принимает отдельной оболочкой `{message, activationEpoch}`.
 */
export function validateInboxMessage(raw, { expectedChannel, expectedAccountRef } = {}) {
  if (expectedChannel === undefined || expectedAccountRef === undefined) {
    fail('Validator обязан получить expectedChannel и expectedAccountRef от server composition.');
  }
  try {
    assertChannel(expectedChannel);
    assertAccountRef(expectedAccountRef);
  } catch (err) {
    fail(`Ожидаемый owner невалиден: ${err.message}`);
  }

  assertExactObject(raw, TOP_LEVEL_KEYS, 'InboxMessage');
  if (raw.schema !== 1) fail('InboxMessage.schema: поддерживается только версия 1.');
  if (raw.channel !== expectedChannel) {
    fail(`InboxMessage.channel: ожидался доверенный канал «${expectedChannel}».`);
  }
  if (raw.accountRef !== expectedAccountRef) {
    fail('InboxMessage.accountRef не совпадает с доверенным account context.');
  }

  assertExactObject(raw.source, SOURCE_KEYS, 'InboxMessage.source');
  assertExactObject(raw.author, AUTHOR_KEYS, 'InboxMessage.author');
  if (!Array.isArray(raw.attachments)) fail('InboxMessage.attachments: ожидался массив.');
  if (raw.attachments.length > INBOX_MESSAGE_LIMITS.attachments) {
    fail(`InboxMessage.attachments: допускается не больше ${INBOX_MESSAGE_LIMITS.attachments} вложений.`);
  }
  if (typeof raw.service !== 'boolean') fail('InboxMessage.service: ожидался boolean.');

  const source = {
    id: assertIdentifier(raw.source.id, 'InboxMessage.source.id'),
    title: assertString(raw.source.title, 'InboxMessage.source.title', {
      maxBytes: INBOX_MESSAGE_LIMITS.sourceTitleBytes,
    }),
    threadId: assertIdentifier(raw.source.threadId, 'InboxMessage.source.threadId', { nullable: true }),
  };
  const author = {
    id: assertIdentifier(raw.author.id, 'InboxMessage.author.id', { nullable: true }),
    name: assertString(raw.author.name, 'InboxMessage.author.name', {
      maxBytes: INBOX_MESSAGE_LIMITS.authorNameBytes,
    }),
  };

  return {
    schema: 1,
    channel: raw.channel,
    accountRef: raw.accountRef,
    source,
    id: assertIdentifier(raw.id, 'InboxMessage.id'),
    parentId: assertIdentifier(raw.parentId, 'InboxMessage.parentId', { nullable: true }),
    groupId: assertIdentifier(raw.groupId, 'InboxMessage.groupId', { nullable: true }),
    occurredAt: assertUnixSeconds(raw.occurredAt, 'InboxMessage.occurredAt'),
    editedAt: assertUnixSeconds(raw.editedAt, 'InboxMessage.editedAt', { nullable: true }),
    author,
    text: assertString(raw.text, 'InboxMessage.text', {
      maxBytes: INBOX_MESSAGE_LIMITS.textBytes,
    }),
    attachments: raw.attachments.map(validateAttachment),
    service: raw.service,
  };
}
