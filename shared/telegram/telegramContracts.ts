// Контракт нативного раздела «Телеграм». Наружу выходит только то, что человек
// видит на экране: токена бота здесь нет и быть не может — сервер отдаёт лишь
// маску последних знаков, а сам секрет остаётся в account-aware хранилище.
//
// Отпечаток правил (`policyFingerprint`) — рубеж решения: это CAS, под которым
// сохраняется allowlist «чат/тема → проект». Строка чужого вида означала бы, что
// правка уедет вслепую поверх чужой, поэтому её форма проверяется здесь, а не
// при попытке записи. Состояние подключения тоже закрыто перечислением: «канал
// подключается» и «канал отвалился» ведут человека к разным действиям.

import { contractDecoders } from '../lib/contractDecoders.ts';

export class TelegramContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ Телеграма: поле ${path}`);
    this.name = 'TelegramContractError';
  }
}

const {
  boolean,
  listOf,
  numeric,
  objectOf,
  oneOf,
  optional,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new TelegramContractError(path);
});

const POLICY_FINGERPRINT_RE = /^telegram-rules-v1:[0-9a-f]{64}$/u;

/**
 * Отпечаток политики правил. Это CAS сохранения allowlist: неверная форма
 * означает, что клиент собирается писать по чужому снимку, и такой ответ
 * отвергается на границе сети, а не при попытке записи.
 */
function policyFingerprint(value: unknown, path: string): string {
  if (typeof value !== 'string' || !POLICY_FINGERPRINT_RE.test(value)) {
    throw new TelegramContractError(path);
  }

  return value;
}

// Бот глазами человека. `tokenHint` — маска последних знаков, а не токен:
// показывать секрет в браузере нельзя, а узнать «тот ли токен» надо.
const telegramBot = objectOf({
  configured: boolean,
  botId: optional(numeric),
  username: optional(text),
  tokenHint: optional(text),
  canReadAllGroupMessages: optional(boolean),
  connectedAt: optional(numeric),
  serviceChatId: optional(numeric),
  serviceChatTitle: optional(text),
  privacyHint: optional(text),
});

// Пульт: сырой id лички наружу не уходит — только подпись чата и маска хвоста.
const telegramPult = objectOf({
  configured: boolean,
  confirmed: boolean,
  pending: boolean,
  chatTitle: optional(text),
  chatHint: optional(text),
});

// Состояние long polling. `conflict` отдельно от ошибки: апдейты этого бота уже
// читает другой экземпляр, и лечится это не повтором, а остановкой второго.
const telegramPoll = objectOf({
  running: boolean,
  offset: optional(wholeNumber),
  lastPollAt: optional(numeric),
  lastMessageAt: optional(numeric),
  lastError: optional(objectOf({
    code: text,
    message: text,
  })),
  conflict: optional(boolean),
});

// Подключение и участие — разные вещи: подключённый бот может не принимать
// новых обращений, и человек включает приём отдельным решением на `/inbox`.
const connectionState = oneOf(
  'disconnected',
  'connecting',
  'connected',
  'disconnecting',
  'switching',
  'degraded',
);

const telegramStatus = objectOf({
  bot: telegramBot,
  pult: optional(telegramPult),
  poll: optional(telegramPoll),
  connection: optional(connectionState),
  reason: optional(text),
});

// Услышанный чат. GrigDesk не спрашивает Телеграм «какие чаты есть»: список
// собирается из того, что бот уже видел, — отсюда счёт сообщений и время.
const telegramChat = objectOf({
  id: numeric,
  title: optional(text),
  username: optional(text),
  type: optional(text),
  isForum: optional(boolean),
  messages: optional(wholeNumber),
  lastAt: optional(numeric),
});

// Тема форума. Список собирается из уже услышанных сообщений: метода «перечислить
// темы» у Bot API нет вовсе, поэтому счёт сообщений здесь — то, что бот видел сам.
const telegramTopic = objectOf({
  id: numeric,
  title: optional(text),
  source: optional(text),
  messages: optional(wholeNumber),
  lastAt: optional(numeric),
});

// Правило привязки. Адрес хранится двумя сторонами намеренно: ссылка на
// приватную группу несёт числовой id, на публичную — только имя.
const telegramRule = objectOf({
  project: text,
  chatId: optional(numeric),
  username: optional(text),
  title: optional(text),
  threadId: optional(numeric),
  kind: oneOf('bug', 'wish'),
  draft: optional(oneOf('manual', 'auto')),
  notifyTaskCreated: optional(boolean),
  agentSearch: optional(boolean),
  b24: objectOf({
    responsibleId: optional(numeric),
    groupId: optional(numeric),
    priority: oneOf(0, 1, 2),
  }),
  autoTask: optional(objectOf({
    enabled: boolean,
    minConfidence: numeric,
    maxPerDay: wholeNumber,
  })),
  autoLaunch: optional(objectOf({
    enabled: boolean,
    route: optional(text),
    minConfidence: numeric,
    maxPerDay: wholeNumber,
    vetoMinutes: wholeNumber,
  })),
});

const telegramRules = objectOf({
  rules: listOf(telegramRule),
  projects: optional(listOf(text)),
  policyFingerprint,
  ownerBound: optional(boolean),
});

const telegramRulesSaved = objectOf({
  ok: optional(boolean),
  rules: listOf(telegramRule),
  policyFingerprint,
  ownerBound: optional(boolean),
});

const telegramChats = objectOf({ chats: listOf(telegramChat) });
const telegramTopics = objectOf({ topics: listOf(telegramTopic) });

const telegramBotResult = objectOf({
  ok: optional(boolean),
  bot: telegramBot,
  poll: optional(telegramPoll),
});

const telegramPultResult = objectOf({
  ok: optional(boolean),
  pult: telegramPult,
});

export type TelegramBot = ReturnType<typeof telegramBot>;
export type TelegramPult = ReturnType<typeof telegramPult>;
export type TelegramPoll = ReturnType<typeof telegramPoll>;
export type TelegramStatus = ReturnType<typeof telegramStatus>;
export type TelegramChat = ReturnType<typeof telegramChat>;
export type TelegramTopic = ReturnType<typeof telegramTopic>;
export type TelegramRule = ReturnType<typeof telegramRule>;
export type TelegramRules = ReturnType<typeof telegramRules>;
export type TelegramRulesSaved = ReturnType<typeof telegramRulesSaved>;
export type TelegramBotResult = ReturnType<typeof telegramBotResult>;
export type TelegramPultResult = ReturnType<typeof telegramPultResult>;

export function parseTelegramStatus(value: unknown): TelegramStatus {
  return telegramStatus(value, 'telegramStatus');
}

export function parseTelegramChats(value: unknown): TelegramChat[] {
  return telegramChats(value, 'telegramChats').chats;
}

export function parseTelegramTopics(value: unknown): TelegramTopic[] {
  return telegramTopics(value, 'telegramTopics').topics;
}

export function parseTelegramRules(value: unknown): TelegramRules {
  return telegramRules(value, 'telegramRules');
}

export function parseTelegramRulesSaved(value: unknown): TelegramRulesSaved {
  return telegramRulesSaved(value, 'telegramRulesSaved');
}

export function parseTelegramBotResult(value: unknown): TelegramBotResult {
  return telegramBotResult(value, 'telegramBot');
}

export function parseTelegramPultResult(value: unknown): TelegramPultResult {
  return telegramPultResult(value, 'telegramPult');
}

/** Форма отпечатка нужна и самому разделу: кнопка сохранения без него мертва. */
export function isTelegramPolicyFingerprint(value: unknown): boolean {
  return typeof value === 'string' && POLICY_FINGERPRINT_RE.test(value);
}
