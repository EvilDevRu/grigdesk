// Общий контракт уточнений внутри активного хода: состояния, receipt, capability и пределы.
//
// Модуль нейтрален и к исполнителю, и к слою: его читают и сервер, и окно. Здесь нет
// ни одного вендорного имени — транспортные различия остаются в адаптерах, а ядро
// спрашивает только capability и доказательство доставки.

// Версия протокола приёма уточнений: окно включает новый режим, только если сервер её объявил.
export const IN_TURN_PROTOCOL = 1;

// Устойчивый id уточнения и запуска: браузер создаёт его до сети, сервер проверяет целиком.
export const IN_TURN_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
// Сегмент пути для chatKey/messageId: разделители и «..» не должны попадать в файловую систему.
export const IN_TURN_SEGMENT_RE = /^[A-Za-z0-9_-]{1,120}$/;

// Продуктовые пределы. Числа живут в одном месте, чтобы сервер и окно не расходились.
export const IN_TURN_TEXT_LIMIT_BYTES = 32 * 1024;
export const IN_TURN_ATTACHMENT_LIMIT = 10;
export const IN_TURN_BACKLOG_LIMIT = 20;
export const IN_TURN_ACTIVE_LIMIT = 50;
export const IN_TURN_ACTIVE_TEXT_LIMIT = 64 * 1024;
export const IN_TURN_PAGE_LIMIT = 50;
export const IN_TURN_PAGE_TEXT_LIMIT = 256 * 1024;
export const IN_TURN_BLOCK_TEXT_LIMIT = 64 * 1024;
export const IN_TURN_SNAPSHOT_LIMIT = 1024 * 1024;
export const IN_TURN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Состояние одного уточнения. `unknown` — не «потеряно», а «внешний эффект не подтверждён»:
// повтор такого сообщения автоматическим быть не может.
export type InTurnDeliveryState =
  | 'accepted'
  | 'delivering'
  | 'forwarded'
  | 'consumed'
  | 'failed'
  | 'unknown';

// Почему канал сейчас закрыт. Причина показывается человеку словами, а не кодом.
export type InTurnUnavailableReason =
  | 'not_ready'
  | 'unsupported'
  | 'compacting'
  | 'workdir_transition'
  | 'chat_busy'
  | 'awaiting_answer';

// Отказ до приёма: сюда попадают только детерминированные проверки.
export type InTurnRejectCode =
  | 'invalid_in_turn_message'
  | 'message_too_large'
  | 'message_conflict'
  | 'turn_changed'
  | 'in_turn_unavailable'
  | 'in_turn_backlog_full'
  | 'server_restarting'
  | 'not_found';

// Картинка уточнения: файл из каталога вложений чата в той же форме, что у обычного
// сообщения истории, — окно показывает её миниатюрой без отдельного преобразования.
export interface InTurnAttachment {
  file: string;
  name: string;
  url: string;
  mime: string;
}

// Проверенный сервером путь картинки для транспорта. Адаптер не строит пути сам.
export interface InTurnImage {
  path: string;
}

// Запись о приёме и доставке, которую окно показывает и восстанавливает после F5.
export interface InTurnReceipt {
  chatKey: string;
  messageId: string;
  runId: string;
  parentTurnId?: string;
  state: InTurnDeliveryState;
  revision: number;
  sequence: number;
  text: string;
  attachments?: InTurnAttachment[];
  sentAt?: number;
  acceptedAt: number;
  updatedAt: number;
  error?: string;
  duplicate?: boolean;
}

// Видимый блок ответа агента. `assistantMessageId` связывает блок с текстовым шагом ленты.
export interface InTurnAssistantBlock {
  runId: string;
  chatKey: string;
  assistantMessageId: string;
  sequence: number;
  revision: number;
  text: string;
  complete: boolean;
  startedAt: number;
  completedAt?: number;
  truncated?: boolean;
  // Черновик брошен: транспорт его не допишет (обрыв, повтор, конец запуска). Блок не полный,
  // но и «Пишет…» про него уже неправда.
  abandoned?: boolean;
}

// Уровень подтверждения, который транспорт реально умеет. `consumed` не синтезируется.
export type InTurnConfirmation = 'forwarded' | 'consumed';

// Что адаптер объявляет о своём канале. Отдельное поле, а не флаг в `capabilities`:
// подробный контракт не втискивается в `Record<string, boolean>` реестра исполнителей.
export interface InTurnCapability {
  protocol: number;
  text: boolean;
  confirmation: InTurnConfirmation;
  // Агент получает картинки уточнения в том же ходе. Без объявления вложение ждёт очереди.
  images?: boolean;
}

// Событие видимого ответа агента от адаптера. Идентичность и текст приходят от
// транспорта, а sequence и публичную revision назначает сервер.
export interface InTurnAssistantEvent {
  assistantMessageId: string;
  text: string;
  sourceRevision: number;
  complete: boolean;
  // Адаптер знает, что начатый текст не продолжится: например, провайдер повторяет запрос
  // с нуля и ответ придёт новым блоком.
  abandoned?: boolean;
}

// Готовность канала у конкретного запуска; ревизия защищает от поздних событий.
export interface InTurnAvailability {
  runId: string;
  available: boolean;
  reason?: InTurnUnavailableReason;
  revision: number;
}

// Результат передачи в транспорт. `uncertain` означает «эффект мог произойти»: повтор запрещён.
export type InTurnDeliverResult =
  | { ok: true; state: InTurnConfirmation }
  | {
    ok: false;
    code: string;
    message: string;
    uncertain?: boolean;
  };

// Порт конкретного запуска. Ядро не знает, чей это транспорт, и не хранит очередь само.
// Ядро передаёт принятые `attachments`, модуль чата переводит их в проверенные пути `images`:
// адаптер видит только пути, а каталог вложений и правила его проверки остаются в ядре.
export interface InTurnPort {
  deliver(input: {
    messageId: string;
    text: string;
    sequence: number;
    attachments?: InTurnAttachment[];
    images?: InTurnImage[];
  }): Promise<InTurnDeliverResult>;
  close?(reason: string): void;
}

// Событие позднего подтверждения: приходит после ответа `deliver` или вовсе без него.
export interface InTurnReceiptEvent {
  messageId: string;
  state: InTurnDeliveryState;
  error?: string;
}

// Снимок запуска для окна: сколько записей отдано и не усечён ли ответ.
export interface InTurnPage {
  entries: Array<InTurnReceipt | InTurnAssistantBlock>;
  nextAfterSequence: number | null;
  throughSequence: number;
  runRevision: number;
  truncated: boolean;
}

/**
 * Проверка объявления capability от адаптера. Реестр исполнителей публикует наружу только
 * разобранную форму: мусор в поле не должен выглядеть как поддержка канала.
 */
export function parseInTurnCapability(value: unknown): InTurnCapability | null {
  const raw = value as Partial<InTurnCapability> | null;

  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const protocol = Number(raw.protocol);
  const confirmation = raw.confirmation === 'consumed' ? 'consumed' : 'forwarded';

  if (!Number.isSafeInteger(protocol) || protocol <= 0 || raw.text !== true) {
    return null;
  }

  return {
    protocol,
    text: true,
    confirmation,
    ...(raw.images === true ? { images: true } : {}),
  };
}

/**
 * Длина текста в байтах UTF-8. Buffer есть не во всех слоях (окно его не знает),
 * поэтому считаем через TextEncoder — одинаково на сервере и в браузере.
 */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(String(text ?? '')).length;
}

/**
 * Обрезка слишком длинного блока: сохраняем начало и хвост с видимой меткой пропуска.
 * Молчаливая потеря середины запрещена: ответ на вопрос не должен исчезать незаметно.
 * Бюджет делится по байтам: кириллица занимает два байта на символ, и счёт по символам
 * выдал бы строку длиннее объявленного предела.
 */
export function cutInTurnText(text: string, limit = IN_TURN_BLOCK_TEXT_LIMIT): {
  text: string;
  truncated: boolean;
} {
  const value = String(text ?? '');

  if (utf8Bytes(value) <= limit) {
    return { text: value, truncated: false };
  }

  const marker = '\n… сокращено …\n';
  const budget = Math.max(0, limit - utf8Bytes(marker));
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;
  const chars = [...value];
  let prefix = '';
  let suffix = '';

  for (const char of chars) {
    if (utf8Bytes(prefix + char) > headBudget) {
      break;
    }

    prefix += char;
  }
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (utf8Bytes(chars[index] + suffix) > tailBudget) {
      break;
    }

    suffix = chars[index] + suffix;
  }

  return { text: `${prefix}${marker}${suffix}`, truncated: true };
}

/**
 * Отпечаток запроса для дедупликации: всё, что влияет на передаваемый prompt. Считается
 * на сервере из принятых полей, а не принимается от клиента, иначе повтор с другим текстом
 * выглядел бы дубликатом.
 */
export function inTurnFingerprint(input: {
  chatKey: string;
  runId: string;
  text: string;
  sentAt?: number;
  context?: unknown;
  files?: readonly string[];
}): string {
  // Файлы дописываются только при наличии: отпечатки уже принятых текстовых уточнений
  // лежат в журнале и обязаны совпасть с повтором после обновления сервера.
  const files = input.files?.length ? [[...input.files]] : [];

  return JSON.stringify([
    input.chatKey,
    input.runId,
    String(input.text ?? ''),
    Number.isSafeInteger(input.sentAt) ? input.sentAt : 0,
    input.context ?? null,
    ...files,
  ]);
}

/**
 * Разрешён ли переход состояния. Позднее подтверждение поднимает `unknown` до
 * `forwarded`/`consumed`, но уже подтверждённое состояние назад не откатывается.
 */
export function canTransition(from: InTurnDeliveryState, to: InTurnDeliveryState): boolean {
  if (from === to) {
    return true;
  }
  if (from === 'consumed' || from === 'failed') {
    return false;
  }
  if (to === 'consumed') {
    return from === 'accepted' || from === 'delivering' || from === 'forwarded' || from === 'unknown';
  }
  if (to === 'forwarded') {
    return from === 'accepted' || from === 'delivering' || from === 'unknown';
  }
  if (to === 'unknown') {
    return from === 'accepted' || from === 'delivering';
  }
  if (to === 'failed') {
    return from === 'accepted' || from === 'delivering';
  }
  if (to === 'delivering') {
    return from === 'accepted';
  }

  return false;
}

/**
 * Ещё не переданные сообщения запуска: именно они держат место в очереди и лимит backlog,
 * а завершённые исходы (в том числе failed) место освобождают.
 */
export function isPendingDelivery(state: InTurnDeliveryState): boolean {
  return state === 'accepted' || state === 'delivering';
}

/**
 * Есть ли в блоке текст для человека. Пустая строка и одни пробелы видимым ответом
 * не считаются: иначе лента показала бы «ответ» там, где модель ничего не сказала.
 */
export function isVisibleAssistantText(text: string): boolean {
  return String(text ?? '').trim().length > 0;
}
