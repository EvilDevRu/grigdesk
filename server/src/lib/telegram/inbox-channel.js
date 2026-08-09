// Account-aware Telegram adapter -> общий Inbox capability.
//
// Lifecycle, token rotation и poller остаются снаружи. Здесь только immutable
// generation lease, native archive/rules и Telegram-specific materialization.
import { FILE_LIMIT, scrubToken } from './api.js';
import { normalizeTelegramBotId } from './account-bindings.js';
import {
  telegramActivationBounds,
  telegramActivationCodec,
  telegramActivationEpochFor,
  telegramActivationMarker,
} from './activation.js';
import { telegramMessageLink } from './links.js';
import { matchRule } from './rules-store.js';
import { safeInboxSourceUrl } from '../inbox/draft.js';
import { assertAccountRef, assertNativeSegment } from '../inbox/identity.js';
import { validateInboxMessage } from '../inbox/message.js';

const CHANNEL = 'telegram';
const LABEL = 'Telegram';
const SETTLE_MS = 600_000;
const MAX_SCAN_POSITIONS = 10_000;
const MAX_LIMIT = MAX_SCAN_POSITIONS;
const SCAN_PAGE_POSITIONS = 1000;
const MAX_MATERIALIZED_ATTACHMENTS = 12;
const MAX_MATERIALIZED_BYTES = 80 * 1024 * 1024;
const TASK_REPLY_TIMEOUT_MS = 5_000;
const TELEGRAM_TEXT_LIMIT = 4_096;
// Название задачи в ответе бота — строка-опознаватель, а не пересказ постановки.
const TASK_REPLY_TITLE_LIMIT = 200;
const TOO_MANY_ATTACHMENTS_REASON = 'too_many_attachments';
const ATTACHMENTS_TOO_LARGE_REASON = 'attachments_too_large';
const POSITION_KEYS = [
  'seq', 'occurredAt', 'revisionSeq', 'chatId', 'chatUsername', 'threadId', 'messageId',
];
const DRAFT_ATTACHMENT_KEYS = [
  'ref', 'dedupeKey', 'kind', 'displayLabel', 'name', 'size', 'messageId', 'groupId',
];
const MEDIA = Object.freeze({
  photo: { kind: 'image', label: 'фото' },
  document: { kind: 'document', label: 'файл' },
  video: { kind: 'video', label: 'видео' },
  animation: { kind: 'animation', label: 'анимация' },
  audio: { kind: 'audio', label: 'аудио' },
  voice: { kind: 'voice', label: 'голосовое сообщение' },
  video_note: { kind: 'video_note', label: 'видеосообщение' },
  sticker: { kind: 'sticker', label: 'стикер' },
});

export class TelegramInboxChannelError extends Error {
  constructor(code, message, statusCode = 500, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TelegramInboxChannelError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode = 500, cause = null) => {
  throw new TelegramInboxChannelError(code, message, statusCode, cause);
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value, keys, where, code = 'telegram_inbox_invalid_contract') {
  if (!isPlainObject(value)) fail(code, `${where}: ожидался объект.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${where}: поля не совпадают с contract v1.`);
  }
}

function callable(value, where) {
  if (typeof value !== 'function') {
    fail('telegram_inbox_invalid_config', `${where} должен быть функцией.`);
  }
  return value;
}

function nonNegative(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('telegram_activation_invalid', `${where}: ожидалось неотрицательное целое.`);
  }
  return value;
}

function positive(value, where) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('telegram_inbox_invalid_archive', `${where}: ожидалось положительное целое.`);
  }
  return value;
}

function telegramId(value, where, { positiveOnly = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (positiveOnly ? value < 1 : value === 0)) {
    fail('telegram_inbox_invalid_archive', `${where}: неверный Telegram id.`);
  }
  return value;
}

function telegramNumber(value, where, options = {}) {
  if (options.nullable && value === null) return null;
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!/^-?[1-9]\d*$/u.test(text)) {
    fail('telegram_inbox_invalid_notification', `${where}: неверный Telegram id.`);
  }
  return telegramId(Number(text), where, options);
}

/**
 * Название задачи собрал не человек, а модель по НЕДОВЕРЕННОМУ тексту чата.
 * Уходит оно одной строкой без разметки (`parse_mode` мы не шлём вовсе):
 * управляющие символы и переносы схлопываем, иначе заголовок в две строки
 * превратил бы ответ бота в кашу и унёс ссылку вниз.
 */
function taskReplyTitle(value) {
  const text = String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!text) return '';
  return text.length <= TASK_REPLY_TITLE_LIMIT
    ? text
    : `${text.slice(0, TASK_REPLY_TITLE_LIMIT - 1).trimEnd()}…`;
}

function taskReplyText(taskId, taskUrl, taskTitle) {
  const id = String(taskId ?? '').trim();
  if (!id || Buffer.byteLength(id, 'utf8') > 512 || /[\u0000-\u001f\u007f]/u.test(id)) {
    fail('telegram_inbox_invalid_notification', 'Task confirmation получил неверный id задачи.');
  }
  let url = '';
  try { url = safeInboxSourceUrl(taskUrl) || ''; } catch { /* номер всё равно полезен */ }
  const title = taskReplyTitle(taskTitle);
  const line = `Задача #${id} поставлена в Битрикс24.`;
  // Лесенка отказа: при переполнении первой уходит ссылка, следом название.
  // Номер задачи остаётся всегда — без него ответ бесполезен.
  const variants = [
    [line, title && `«${title}»`, url],
    [line, title && `«${title}»`],
    [line],
  ];
  for (const variant of variants) {
    const text = variant.filter(Boolean).join('\n');
    if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  }
  return line;
}

export {
  telegramActivationCodec,
  telegramActivationEpochFor,
  telegramActivationMarker,
};

function canonicalNativeId(value, where, opts = {}) {
  if (opts.nullable && value === null) return null;
  if (typeof value === 'number') return String(telegramId(value, where, opts));
  if (opts.opaqueString && typeof value === 'string') {
    try { return assertNativeSegment(value, where); } catch (err) {
      fail('telegram_inbox_invalid_archive', `${where}: невалидный native id.`, 500, err);
    }
  }
  fail('telegram_inbox_invalid_archive', `${where}: ожидался native id.`);
}

function boundedString(value, where, maxBytes, { empty = true } = {}) {
  if (typeof value !== 'string') fail('telegram_inbox_invalid_archive', `${where}: ожидалась строка.`);
  const size = Buffer.byteLength(value, 'utf8');
  if ((!empty && size === 0) || size > maxBytes) {
    fail('telegram_inbox_invalid_archive', `${where}: строка имеет неверный размер.`);
  }
  return value;
}

function attachmentOf(raw, index) {
  if (!isPlainObject(raw)) {
    fail('telegram_inbox_invalid_archive', `media[${index}] не является объектом.`);
  }
  const presentation = MEDIA[raw.kind];
  if (!presentation) {
    fail('telegram_inbox_invalid_archive', `media[${index}].kind неизвестен.`);
  }
  const fileId = boundedString(raw.fileId, `media[${index}].fileId`, 8192, { empty: false });
  const uniqueId = raw.uniqueId === undefined || raw.uniqueId === null
    ? ''
    : boundedString(raw.uniqueId, `media[${index}].uniqueId`, 8192);
  const name = raw.name === undefined || raw.name === null
    ? ''
    : boundedString(raw.name, `media[${index}].name`, 4096);
  const size = raw.size === undefined || raw.size === null ? null : raw.size;
  if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
    fail('telegram_inbox_invalid_archive', `media[${index}].size невалиден.`);
  }
  return {
    ref: fileId,
    dedupeKey: uniqueId || fileId,
    kind: presentation.kind,
    displayLabel: presentation.label,
    name,
    size,
  };
}

/** Native normalized archive row -> exact InboxMessage v1. */
export function toInboxMessage(nativeMessage, { accountRef } = {}) {
  const owner = assertAccountRef(accountRef);
  if (!isPlainObject(nativeMessage)) {
    fail('telegram_inbox_invalid_archive', 'Telegram native message не является объектом.');
  }
  const sourceId = canonicalNativeId(nativeMessage.chatId, 'message.chatId');
  const messageId = canonicalNativeId(nativeMessage.messageId, 'message.messageId', { positiveOnly: true });
  const threadId = canonicalNativeId(nativeMessage.threadId ?? null, 'message.threadId', {
    positiveOnly: true,
    nullable: true,
  });
  const parentId = canonicalNativeId(nativeMessage.replyToMessageId ?? null, 'message.replyToMessageId', {
    positiveOnly: true,
    nullable: true,
  });
  const groupId = canonicalNativeId(nativeMessage.mediaGroupId ?? null, 'message.mediaGroupId', {
    nullable: true,
    opaqueString: true,
  });
  const occurredAt = nonNegative(nativeMessage.date, 'message.date');
  const editedAt = nativeMessage.editedAt === null || nativeMessage.editedAt === undefined
    ? null
    : nonNegative(nativeMessage.editedAt, 'message.editedAt');
  if (!isPlainObject(nativeMessage.from)) {
    fail('telegram_inbox_invalid_archive', 'message.from не является объектом.');
  }
  const authorId = nativeMessage.from.id === null || nativeMessage.from.id === undefined
    ? null
    : canonicalNativeId(nativeMessage.from.id, 'message.from.id');
  const sourceTitle = boundedString(
    nativeMessage.threadTitle || nativeMessage.chatTitle || '',
    'message source title',
    4096,
  );
  const media = nativeMessage.media === undefined ? [] : nativeMessage.media;
  if (!Array.isArray(media) || media.length > 100) {
    fail('telegram_inbox_invalid_archive', 'message.media должен быть ограниченным массивом.');
  }

  try {
    return validateInboxMessage({
      schema: 1,
      channel: CHANNEL,
      accountRef: owner,
      source: { id: sourceId, title: sourceTitle, threadId },
      id: messageId,
      parentId,
      groupId,
      occurredAt,
      editedAt,
      author: {
        id: authorId,
        name: boundedString(nativeMessage.from.name || '', 'message.from.name', 1024),
      },
      text: boundedString(nativeMessage.text || '', 'message.text', 1024 * 1024),
      attachments: media.map(attachmentOf),
      service: Boolean(nativeMessage.service),
    }, { expectedChannel: CHANNEL, expectedAccountRef: owner });
  } catch (err) {
    if (err instanceof TelegramInboxChannelError) throw err;
    fail('telegram_inbox_invalid_archive', 'Telegram native message не прошёл Inbox contract.', 500, err);
  }
}

function generationOf(value) {
  if (typeof value === 'string' && value) return value;
  if (Number.isSafeInteger(value) && value >= 1) return value;
  fail('telegram_inbox_invalid_context', 'Telegram Inbox lease имеет неверную generation.');
}

function inboxStateOf(value) {
  if (!value || typeof value !== 'object') {
    fail('telegram_inbox_invalid_context', 'Telegram Inbox lease не выдал inboxState.');
  }
  for (const method of ['read', 'summary', 'activationWindows', 'activate', 'deactivate']) {
    if (typeof value[method] !== 'function') {
      fail('telegram_inbox_invalid_context', `Telegram inboxState требует ${method}().`);
    }
  }
  return value;
}

function archiveOf(value) {
  if (!value || typeof value !== 'object'
      || typeof value.head !== 'function'
      || typeof value.listInboxPositions !== 'function'
      || typeof value.readInboxPosition !== 'function') {
    fail(
      'telegram_inbox_invalid_context',
      'Telegram Inbox lease не выдал archive head/listInboxPositions/readInboxPosition.',
    );
  }
  return value;
}

function rulesOf(value) {
  if (!value || typeof value !== 'object' || typeof value.read !== 'function') {
    fail('telegram_inbox_invalid_context', 'Telegram Inbox lease не выдал rules.read().');
  }
  return value;
}

function credentialsOf(value, botId) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    fail('telegram_inbox_invalid_context', 'Telegram credential snapshot не является объектом.');
  }
  let credentialBotId;
  try { credentialBotId = normalizeTelegramBotId(value.botId); } catch (err) {
    fail('telegram_inbox_invalid_context', 'Telegram credential botId невалиден.', 500, err);
  }
  const token = typeof value.token === 'string' ? value.token : '';
  if (credentialBotId !== botId || !token || token.split(':', 1)[0] !== botId
      || token.length > 16 * 1024 || /[\0\r\n\s]/u.test(token)) {
    fail('telegram_inbox_invalid_context', 'Telegram credential snapshot не совпадает с bot owner.');
  }
  return { botId, token };
}

function botApiOf(value) {
  if (!value || typeof value !== 'object'
      || typeof value.getFile !== 'function'
      || typeof value.downloadFile !== 'function'
      || typeof value.callBotApi !== 'function') {
    fail('telegram_inbox_invalid_context', 'Telegram Inbox lease не выдал полный Bot API transport.');
  }
  return value;
}

function leaseOf(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.context)) {
    fail('telegram_inbox_invalid_context', 'acquireInboxLease вернул неверный lease.');
  }
  let accountRef;
  let botId;
  try {
    accountRef = assertAccountRef(raw.accountRef, 'Telegram Inbox lease.accountRef');
    botId = normalizeTelegramBotId(raw.context.botId);
  } catch (err) {
    fail('telegram_inbox_invalid_context', 'Telegram Inbox lease owner невалиден.', 500, err);
  }
  return {
    raw,
    accountRef,
    botId,
    generation: generationOf(raw.generation),
    archive: archiveOf(raw.context.archive),
    rules: rulesOf(raw.context.rules),
    inboxState: inboxStateOf(raw.context.inboxState),
    credentials: credentialsOf(raw.context.credentials, botId),
    botApi: botApiOf(raw.context.botApi),
    createActivationMarker: callable(
      raw.context.createActivationMarker,
      'Telegram raw context.createActivationMarker',
    ),
    isCurrent: callable(raw.isCurrent, 'Telegram Inbox lease.isCurrent'),
    release: callable(raw.release, 'Telegram Inbox lease.release'),
  };
}

function safeNow(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('telegram_inbox_invalid_request', 'nowMs должен быть неотрицательным safe integer.', 400);
  }
  return value;
}

function requestedLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    fail('telegram_inbox_invalid_request', `limit должен быть целым 1..${MAX_LIMIT}.`, 400);
  }
  return value;
}

function positionOf(raw, cursor) {
  exact(raw, POSITION_KEYS, 'Telegram archive position', 'telegram_inbox_invalid_archive');
  const seq = positive(raw.seq, 'position.seq');
  if (seq <= cursor) {
    fail('telegram_inbox_invalid_archive', 'Telegram positions нарушили возрастающий seq cursor.');
  }
  return {
    seq,
    occurredAt: nonNegative(raw.occurredAt, 'position.occurredAt'),
    revisionSeq: positive(raw.revisionSeq, 'position.revisionSeq'),
    chatId: telegramId(raw.chatId, 'position.chatId'),
    chatUsername: boundedString(raw.chatUsername, 'position.chatUsername', 256),
    threadId: telegramId(raw.threadId, 'position.threadId', { positiveOnly: true, nullable: true }),
    messageId: telegramId(raw.messageId, 'position.messageId', { positiveOnly: true }),
  };
}

function scopeIdOf(chatId, ruleThreadId) {
  const tuple = [
    1,
    'telegram-policy-scope',
    String(chatId),
    ruleThreadId === null ? null : String(ruleThreadId),
  ];
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

function policyOf(rule, position) {
  if (!isPlainObject(rule)) {
    fail('telegram_inbox_invalid_policy', 'Telegram rule имеет неверный формат.');
  }
  const threadId = rule.threadId === null
    ? null
    : telegramId(rule.threadId, 'rule.threadId', { positiveOnly: true });
  if (typeof rule.project !== 'string' || !rule.project
      || typeof rule.kind !== 'string'
      || !isPlainObject(rule.b24) || !isPlainObject(rule.autoTask)) {
    fail('telegram_inbox_invalid_policy', 'Telegram rule не содержит strict Inbox policy.');
  }
  return {
    scopeId: scopeIdOf(position.chatId, threadId),
    project: rule.project,
    kind: rule.kind,
    b24: {
      responsibleId: rule.b24.responsibleId,
      groupId: rule.b24.groupId,
      priority: rule.b24.priority,
    },
    autoTask: {
      enabled: rule.autoTask.enabled,
      minConfidence: rule.autoTask.minConfidence,
      maxPerDay: rule.autoTask.maxPerDay,
    },
  };
}

function snapshotMatchesPosition(snapshot, position) {
  return isPlainObject(snapshot)
    && snapshot.chatId === position.chatId
    && snapshot.messageId === position.messageId
    && snapshot.date === position.occurredAt
    && (snapshot.chatUsername || '') === position.chatUsername
    && (snapshot.threadId ?? null) === position.threadId;
}

function sourceUrlOf(snapshot) {
  return telegramMessageLink({
    chatId: snapshot.chatId,
    chatUsername: snapshot.chatUsername,
    threadId: snapshot.threadId,
    messageId: snapshot.messageId,
  });
}

function cacheKey(sourceId, messageId) {
  return JSON.stringify([sourceId, messageId]);
}

function attachmentCacheKey(attachment) {
  // Один и тот же Telegram file может встречаться в нескольких сообщениях.
  // Авторизация materialize привязана к точному occurrence, а не только file_id.
  return JSON.stringify([
    attachment.dedupeKey,
    attachment.ref,
    attachment.messageId,
    attachment.groupId ?? null,
  ]);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileNameOf(attachment, filePath = '') {
  const tail = String(filePath).split('/').pop() || '';
  const own = String(attachment.name || '').trim();
  if (!own) return tail || attachment.displayLabel || 'вложение';
  if (/\.[a-z0-9]{1,8}$/iu.test(own)) return own;
  const dot = tail.lastIndexOf('.');
  return dot > 0 ? `${own}${tail.slice(dot)}` : own;
}

const megabytes = (bytes) => Math.round(bytes / 1024 / 1024);
const oversizeReason = (bytes) => (
  `файл ${megabytes(bytes)} МБ — бот не может скачать больше ${megabytes(FILE_LIMIT)} МБ`
);

function validateDraftAttachment(raw, cache) {
  exact(raw, DRAFT_ATTACHMENT_KEYS, 'Telegram draft attachment', 'telegram_inbox_invalid_attachments');
  const known = cache.get(attachmentCacheKey(raw));
  if (!known || !sameJson(raw, known)) {
    fail(
      'telegram_inbox_invalid_attachments',
      'Telegram attachment запрошен вне текущего authorized batch.',
    );
  }
  return known;
}

/**
 * acquireInboxLease() -> immutable
 * {accountRef,generation,isCurrent,release,context:{
 *   botId,archive,rules,inboxState,credentials:{botId,token}|null,botApi
 * }}.
 */
export function createTelegramInboxChannel({ enabled, state, acquireInboxLease } = {}) {
  const enabledCallback = callable(enabled, 'enabled');
  const stateCallback = callable(state, 'state');
  const acquireCallback = callable(acquireInboxLease, 'acquireInboxLease');

  return {
    id: CHANNEL,
    label: LABEL,
    grouping: { settleMs: SETTLE_MS },

    async enabled() { return Boolean(await enabledCallback()); },

    async state() {
      const raw = await stateCallback();
      if (!isPlainObject(raw)) {
        fail('telegram_inbox_invalid_state', 'Telegram channel state callback вернул не объект.');
      }
      return {
        connection: raw.connection,
        participation: raw.participation,
        reason: raw.reason ?? null,
      };
    },

    async acquireInboxContext() {
      const rawLease = await acquireCallback();
      let owner;
      try {
        owner = leaseOf(rawLease);
      } catch (err) {
        try { await rawLease?.release?.(); } catch { /* исходная ошибка важнее cleanup */ }
        throw err;
      }

      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await owner.release.call(owner.raw);
      };
      const isCurrent = async () => Boolean(await owner.isCurrent.call(owner.raw));
      const assertCurrent = async () => {
        if (!await isCurrent()) {
          fail('stale_generation', 'Telegram account generation изменилась во время Inbox operation.', 409);
        }
      };
      const sourceUrls = new Map();
      const taskReplies = new Map();
      const attachmentCache = new Map();

      try { await assertCurrent(); } catch (err) {
        await release().catch(() => {});
        throw err;
      }

      return {
        accountRef: owner.accountRef,
        generation: owner.generation,
        inboxState: owner.inboxState,

        async createActivationMarker({ nowMs } = {}) {
          safeNow(nowMs);
          await assertCurrent();
          const marker = await owner.createActivationMarker.call(owner.raw.context, { nowMs });
          await assertCurrent();
          return telegramActivationCodec.decode(marker);
        },

        async listAuthorizedBatches({ nowMs, limit, activationWindows } = {}) {
          safeNow(nowMs);
          const wanted = requestedLimit(limit);
          await assertCurrent();
          const bounds = telegramActivationBounds(activationWindows);
          sourceUrls.clear();
          taskReplies.clear();
          attachmentCache.clear();
          if (bounds === null) return [];

          // Allowlist обязан быть получен до первого archive snapshot read.
          await assertCurrent();
          const rules = await owner.rules.read();
          await assertCurrent();
          if (!Array.isArray(rules)) {
            fail('telegram_inbox_invalid_policy', 'Telegram rules.read вернул не массив.');
          }
          if (rules.length === 0) return [];

          const admitted = [];
          let cursor = bounds.afterSeq;
          let scanned = 0;
          let truncated = false;
          scan: while (scanned < MAX_SCAN_POSITIONS) {
            const pageLimit = Math.min(SCAN_PAGE_POSITIONS, MAX_SCAN_POSITIONS - scanned);
            await assertCurrent();
            const rawPositions = await owner.archive.listInboxPositions({
              afterSeq: cursor,
              throughSeq: bounds.throughSeq,
              limit: pageLimit,
            });
            await assertCurrent();
            if (!Array.isArray(rawPositions) || rawPositions.length > pageLimit) {
              fail('telegram_inbox_invalid_archive', 'Telegram position scan вернул неверную page.');
            }
            if (rawPositions.length === 0) break;

            for (const rawPosition of rawPositions) {
              const position = positionOf(rawPosition, cursor);
              cursor = position.seq;
              scanned += 1;
              const activationEpoch = telegramActivationEpochFor(position, bounds.windows);
              if (activationEpoch === null) continue;
              const rule = matchRule(rules, {
                chatId: position.chatId,
                username: position.chatUsername,
                threadId: position.threadId,
              });
              if (rule === null) continue;
              if (admitted.length >= wanted) {
                truncated = true;
                break scan;
              }

              await assertCurrent();
              const snapshot = await owner.archive.readInboxPosition(position);
              await assertCurrent();
              if (!snapshotMatchesPosition(snapshot, position)) {
                fail('telegram_inbox_invalid_archive', 'Telegram snapshot не совпадает с metadata position.');
              }
              const message = toInboxMessage(snapshot, { accountRef: owner.accountRef });
              const urlKey = cacheKey(message.source.id, message.id);
              sourceUrls.set(urlKey, sourceUrlOf(snapshot));
              taskReplies.set(urlKey, Object.freeze({
                enabled: rule.notifyTaskCreated === true,
                chatId: message.source.id,
                messageId: message.id,
                threadId: message.source.threadId,
              }));
              for (const attachment of message.attachments) {
                const draftShape = {
                  ...attachment,
                  messageId: message.id,
                  groupId: message.groupId,
                };
                const key = attachmentCacheKey(draftShape);
                if (!attachmentCache.has(key)) attachmentCache.set(key, draftShape);
              }
              admitted.push({
                activationEpoch,
                source: { ...message.source },
                messages: [message],
                policy: policyOf(rule, position),
                truncated: false,
              });
              if (scanned >= MAX_SCAN_POSITIONS) break scan;
            }

            if (rawPositions.length < pageLimit) break;
            if (bounds.throughSeq !== null && cursor >= bounds.throughSeq) break;
          }

          if (!truncated && scanned >= MAX_SCAN_POSITIONS) {
            await assertCurrent();
            const probe = await owner.archive.listInboxPositions({
              afterSeq: cursor,
              throughSeq: bounds.throughSeq,
              limit: 1,
            });
            await assertCurrent();
            if (!Array.isArray(probe) || probe.length > 1) {
              fail('telegram_inbox_invalid_archive', 'Telegram truncation probe невалиден.');
            }
            truncated = probe.length === 1;
          }
          if (truncated && admitted.length === 0) {
            fail(
              'telegram_inbox_scan_truncated',
              'Telegram archive scan исчерпал безопасный bound без результата.',
            );
          }
          for (const batch of admitted) batch.truncated = truncated;
          await assertCurrent();
          return admitted;
        },

        sourceUrl({ source, message } = {}) {
          const key = cacheKey(source?.id, message?.id);
          if (!sourceUrls.has(key) || message?.source?.id !== source?.id) {
            fail('telegram_inbox_invalid_source', 'Telegram source URL запрошен вне authorized batch.');
          }
          return sourceUrls.get(key);
        },

        async notifyTaskCreated({ source, message, taskId, taskUrl, title } = {}) {
          await assertCurrent();
          const key = cacheKey(source?.id, message?.id);
          const target = taskReplies.get(key);
          if (!sourceUrls.has(key)
              || !target
              || source?.id !== target.chatId
              || message?.id !== target.messageId
              || source?.threadId !== target.threadId
              || message?.source?.id !== source?.id
              || message?.source?.threadId !== source?.threadId) {
            fail(
              'telegram_inbox_invalid_notification',
              'Telegram confirmation запрошен вне exact authorized message.',
            );
          }
          if (!target.enabled) return { enabled: false, sent: false };
          if (!await enabledCallback()) return { enabled: true, sent: false, reason: 'plugin_disabled' };

          const token = owner.credentials?.token || '';
          if (!token) {
            fail('telegram_inbox_notification_unavailable', 'Telegram bot не подключён для ответа.', 409);
          }
          const chatId = telegramNumber(target.chatId, 'notification.chatId');
          const messageId = telegramNumber(target.messageId, 'notification.messageId', { positiveOnly: true });
          const threadId = telegramNumber(target.threadId, 'notification.threadId', {
            positiveOnly: true,
            nullable: true,
          });
          const body = {
            chat_id: chatId,
            text: taskReplyText(taskId, taskUrl, title),
            link_preview_options: { is_disabled: true },
            reply_parameters: {
              message_id: messageId,
              allow_sending_without_reply: true,
            },
          };
          if (threadId !== null) body.message_thread_id = threadId;

          await assertCurrent();
          await owner.botApi.callBotApi(token, 'sendMessage', body, {
            timeoutMs: TASK_REPLY_TIMEOUT_MS,
          });
          await assertCurrent();
          return { enabled: true, sent: true };
        },

        async materializeAttachments(attachments) {
          await assertCurrent();
          if (!Array.isArray(attachments)) {
            fail('telegram_inbox_invalid_attachments', 'Telegram attachments должен быть массивом.');
          }
          const requested = attachments.map((attachment) => (
            validateDraftAttachment(attachment, attachmentCache)
          ));
          const files = [];
          const skipped = [];
          const token = owner.credentials?.token || '';
          let materializedBytes = 0;

          for (const [index, attachment] of requested.entries()) {
            await assertCurrent();
            if (index >= MAX_MATERIALIZED_ATTACHMENTS) {
              skipped.push({ index, attachment, reason: TOO_MANY_ATTACHMENTS_REASON });
              continue;
            }
            if (!token) {
              skipped.push({ index, attachment, reason: 'бот не подключён — файл не забрать' });
              continue;
            }
            if (attachment.size !== null && attachment.size > FILE_LIMIT) {
              skipped.push({ index, attachment, reason: oversizeReason(attachment.size) });
              continue;
            }
            if (materializedBytes >= MAX_MATERIALIZED_BYTES
                || (attachment.size !== null
                  && attachment.size > MAX_MATERIALIZED_BYTES - materializedBytes)) {
              skipped.push({ index, attachment, reason: ATTACHMENTS_TOO_LARGE_REASON });
              continue;
            }
            try {
              const found = await owner.botApi.getFile(token, attachment.ref);
              await assertCurrent();
              if (!isPlainObject(found) || typeof found.filePath !== 'string'
                  || (found.size !== null && found.size !== undefined
                    && (!Number.isSafeInteger(found.size) || found.size < 0))) {
                throw new Error('Bot API вернул неверное описание файла');
              }
              if (found.size !== null && found.size !== undefined && found.size > FILE_LIMIT) {
                throw new Error(oversizeReason(found.size));
              }
              const expectedSize = Math.max(attachment.size ?? 0, found.size ?? 0);
              if (expectedSize > MAX_MATERIALIZED_BYTES - materializedBytes) {
                skipped.push({ index, attachment, reason: ATTACHMENTS_TOO_LARGE_REASON });
                continue;
              }
              const bytes = await owner.botApi.downloadFile(token, found.filePath, {
                limit: Math.min(FILE_LIMIT, MAX_MATERIALIZED_BYTES - materializedBytes),
              });
              await assertCurrent();
              if (!(bytes instanceof Uint8Array) || bytes.byteLength > FILE_LIMIT) {
                throw new Error(bytes?.byteLength > FILE_LIMIT
                  ? oversizeReason(bytes.byteLength)
                  : 'Bot API вернул неверные байты файла');
              }
              const accountedSize = Math.max(expectedSize, bytes.byteLength);
              if (accountedSize > MAX_MATERIALIZED_BYTES - materializedBytes) {
                skipped.push({ index, attachment, reason: ATTACHMENTS_TOO_LARGE_REASON });
                continue;
              }
              const buffer = Buffer.from(bytes);
              files.push({
                index,
                buffer,
                name: fileNameOf(attachment, found.filePath),
                kind: attachment.kind,
                displayLabel: attachment.displayLabel,
                size: buffer.byteLength,
              });
              materializedBytes += accountedSize;
            } catch (err) {
              // Generation switch не превращается в partial attachment failure.
              await assertCurrent();
              skipped.push({
                index,
                attachment,
                reason: scrubToken(err?.message || 'причина неизвестна', token),
              });
            }
          }
          await assertCurrent();
          return { files, skipped };
        },

        isCurrent,
        release,
      };
    },
  };
}

export default createTelegramInboxChannel;
