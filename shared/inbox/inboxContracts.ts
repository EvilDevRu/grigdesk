// Контракт общего Inbox. Сюда стекаются обращения из разных каналов, но браузер
// видит одну общую проекцию: ни provider identity, ни accountRef, ни родного payload
// канала здесь нет и быть не может — сервер их не отдаёт, и контракт это закрепляет.
//
// Решение по сообщению — рубеж: по нему создаётся задача в Битрикс24 или обращение
// уходит в историю. Поэтому статус решения и состояние канала закрыты перечислениями,
// а `revision` и `activationVersion` проверяются строго: на них стоит оптимистичная
// блокировка, и подставная форма превратила бы её в запись поверх чужого решения.

import { contractDecoders } from '../lib/contractDecoders.ts';

export class InboxContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ входящих: поле ${path}`);
    this.name = 'InboxContractError';
  }
}

const {
  boolean,
  listOf,
  nullable,
  numeric,
  objectOf,
  oneOf,
  optional,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new InboxContractError(path);
});

// Что стало с сообщением. `skipped` возвращаемо, `task` — нет: задача уже создана.
const decisionStatus = oneOf('task', 'skipped');

const inboxDecision = objectOf({
  decisionId: text,
  version: wholeNumber,
  status: decisionStatus,
  taskId: nullable(text),
  taskUrl: optional(text),
  by: nullable(text),
  note: nullable(text),
  decidedAtMs: nullable(numeric),
});

// Ход разбора вложения. Он приходит то объектом, то одной строкой статуса — обе
// формы законны, и раздел показывает по ним одну и ту же подпись человеку.
const analysisDetail = objectOf({
  status: optional(text),
  transcript: optional(text),
  text: optional(text),
});

function attachmentAnalysis(value: unknown, path: string) {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'string' ? value : analysisDetail(value, path);
}

// Вложение показывается подписью и размером: содержимое остаётся в канале, а GrigDesk
// готовит его отдельно и только по решению человека. Ход разбора необязателен —
// у канала без такой подготовки его нет вовсе.
const inboxAttachment = objectOf({
  kind: text,
  displayLabel: optional(text),
  name: optional(text),
  size: optional(numeric),
  status: optional(text),
  transcript: optional(text),
  attachmentAnalysis,
  analysis: attachmentAnalysis,
});

const inboxMessage = objectOf({
  messageRef: text,
  occurredAt: numeric,
  editedAt: nullable(numeric),
  author: objectOf({ name: optional(text) }),
  text,
  attachments: listOf(inboxAttachment),
  decision: nullable(inboxDecision),
});

// Состояние карточки. `mixed` означает, что часть сообщений уже разобрана: карточка
// не пустая и не закрытая, и обе вкладки человека обязаны её различать.
const itemStatus = oneOf('new', 'mixed', 'task', 'skipped');

const inboxItem = objectOf({
  ref: text,
  revision: text,
  channel: objectOf({
    id: text,
    label: optional(text),
  }),
  source: objectOf({
    title: optional(text),
    url: optional(text),
  }),
  project: optional(text),
  kind: optional(text),
  status: itemStatus,
  decision: nullable(inboxDecision),
  firstAt: numeric,
  lastAt: numeric,
  cold: boolean,
  autoTask: objectOf({
    enabled: boolean,
    readyAtMs: numeric,
  }),
  title: optional(text),
  description: optional(text),
  truncated: optional(boolean),
  messages: listOf(inboxMessage),
  attachments: listOf(inboxAttachment),
});

// Состояние канала. Подключение и участие — разные вещи: подключённый канал может
// не принимать новых обращений, и человек включает приём отдельным решением.
const channelConnection = oneOf('connected', 'connecting', 'disconnected', 'degraded');
const channelParticipation = oneOf('never_activated', 'active', 'deactivated');

const inboxChannel = objectOf({
  id: text,
  label: text,
  plugin: oneOf('enabled', 'disabled'),
  connection: channelConnection,
  participation: channelParticipation,
  activationVersion: wholeNumber,
  currentEpoch: nullable(wholeNumber),
  startedAtMs: nullable(numeric),
  endedAtMs: nullable(numeric),
  endReason: nullable(text),
  reason: nullable(text),
  readOnly: boolean,
  truncated: boolean,
});

const channelError = objectOf({
  channel: text,
  code: text,
  message: text,
});

// Нехватка разбора вложения. Подпись та же, что уже видна в карточке, а причину
// формулирует сам GrigDesk — пересказывать её человеку иначе нечем.
const blockedAttachment = objectOf({
  label: text,
  reason: optional(text),
});

/**
 * Карточка, которую автомат не берёт: вложения не разобрались. У каждого файла своя
 * причина — потолок Telegram ожиданием не лечится, а сетевой сбой лечится, — поэтому
 * список причин едет вместе с временем следующей попытки.
 */
const analysisBlock = objectOf({
  ref: text,
  channel: optional(text),
  code: optional(text),
  revision: optional(text),
  attachments: optional(listOf(blockedAttachment)),
  checkedAtMs: optional(numeric),
  retryAtMs: optional(numeric),
});

/**
 * Состояние автообработчика. Оно объясняет человеку, почему автозадачи молчат:
 * «модель не выбрана» и «Битрикс24 не подключён» — разные причины с разными
 * следующими шагами, и сводить их к одному «остановлен» нельзя.
 */
const inboxWorker = objectOf({
  running: boolean,
  readiness: optional(text),
  lastTickAt: optional(numeric),
  lastReason: optional(text),
  lastError: optional(text),
  judging: optional(objectOf({
    ref: text,
    channel: optional(text),
    startedAtMs: numeric,
  })),
  created: optional(wholeNumber),
  dismissed: optional(wholeNumber),
  failed: optional(wholeNumber),
  blockedChannels: optional(listOf(text)),
  analysisRequired: optional(listOf(analysisBlock)),
});

const inboxList = objectOf({
  items: listOf(inboxItem),
  channels: listOf(inboxChannel),
  errors: listOf(channelError),
  truncated: boolean,
  limit: optional(wholeNumber),
  worker: nullable(inboxWorker),
});

/**
 * Сводка для навигации. `reviewCount` повторяет вкладку человека «К разбору», а
 * `newCount` считает созревшее для автомата: это разные числа, и подменять одно
 * другим значило бы показать в шапке не ту очередь.
 */
const inboxSummary = objectOf({
  newCount: wholeNumber,
  mixedCount: wholeNumber,
  reviewCount: optional(wholeNumber),
  truncated: boolean,
  channels: optional(listOf(objectOf({
    id: text,
    newCount: wholeNumber,
    mixedCount: wholeNumber,
    reviewCount: optional(wholeNumber),
    truncated: boolean,
  }))),
  errors: optional(listOf(channelError)),
});

const decisionRef = objectOf({
  decisionId: text,
  version: wholeNumber,
});

// Ответ в исходный чат — отдельное дело от самой задачи: задача уже создана, и
// неудачная доставка ответа не повод считать решение несостоявшимся. Автоповтора у
// ответа нет по замыслу, поэтому «не отправлен» обязан дойти до человека.
const notification = objectOf({
  enabled: boolean,
  sent: boolean,
  reason: optional(text),
});

const decisionResult = objectOf({
  decision: optional(decisionRef),
  item: optional(nullable(inboxItem)),
  taskId: optional(text),
  taskUrl: optional(text),
  notification: optional(nullable(notification)),
});

const activationResult = objectOf({
  channel: optional(text),
  activationVersion: optional(wholeNumber),
  participation: optional(channelParticipation),
});

export type InboxItem = ReturnType<typeof inboxItem>;
export type InboxMessage = ReturnType<typeof inboxMessage>;
export type InboxDecision = ReturnType<typeof inboxDecision>;
export type InboxAttachment = ReturnType<typeof inboxAttachment>;
export type InboxChannel = ReturnType<typeof inboxChannel>;
export type InboxChannelError = ReturnType<typeof channelError>;
export type InboxWorker = ReturnType<typeof inboxWorker>;
export type InboxList = ReturnType<typeof inboxList>;
export type InboxSummary = ReturnType<typeof inboxSummary>;
export type InboxDecisionResult = ReturnType<typeof decisionResult>;
export type InboxBlockedAttachment = ReturnType<typeof blockedAttachment>;

// Что уезжает на сервер вместе с решением. Ревизия карточки и версия решения — это
// оптимистичная блокировка: без них ответ лёг бы поверх чужого разбора.
export interface InboxDecisionInput {
  revision?: string;
  messageRefs?: string[];
  decisionId?: string;
  decisionVersion?: number;
  operatorNote?: string;
}

export function parseInboxList(value: unknown): InboxList {
  return inboxList(value, 'inboxList');
}

export function parseInboxSummary(value: unknown): InboxSummary {
  return inboxSummary(value, 'inboxSummary');
}

export function parseInboxDecisionResult(value: unknown): InboxDecisionResult {
  return decisionResult(value, 'inboxDecision');
}

export function parseInboxActivation(value: unknown) {
  return activationResult(value, 'inboxActivation');
}

/**
 * Список вложений, помешавших поставить задачу. Он приезжает в теле отказа, а не
 * в общем ответе: человек читает его прямо в модалке пояснения.
 */
export function parseInboxBlockedAttachments(value: unknown): InboxBlockedAttachment[] {
  return Array.isArray(value)
    ? value.map((entry, index) => blockedAttachment(entry, `inboxBlocked[${index}]`))
    : [];
}
