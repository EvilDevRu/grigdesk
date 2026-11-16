import type {
  InTurnAssistantBlock,
  InTurnAvailability,
  InTurnPage,
  InTurnReceipt,
} from '../../../shared/chat/chatInTurnContracts.ts';
import { canTransition } from '../../../shared/chat/chatInTurnContracts.ts';
import { ownHistorySteps } from '../shared/chatHistorySnapshot.ts';

export type InTurnEntry = InTurnReceipt | InTurnAssistantBlock;

export interface ChatInTurnRun {
  chatKey: string;
  runId: string;
  active: boolean;
  parentTurnId?: string;
  availability: InTurnAvailability | null;
  entries: InTurnEntry[];
  throughSequence: number;
  runRevision: number;
  completeThrough: number;
}

type HistoryMessage = Record<string, unknown>;

type HistoryMessageIndex = {
  receipts: Map<string, HistoryMessage>;
  assistants: Map<string, HistoryMessage>;
};

interface AssistantFinalIdentity {
  runId?: unknown;
  assistantMessageId?: unknown;
  finalAssistantMessageId?: unknown;
}

/**
 * Новый run начинает с пустой ленты и неизвестной готовности транспорта.
 * Его id остаётся якорем всех поздних SSE и страниц восстановления.
 */
export function newChatInTurnRun(chatKey: string, runId: string): ChatInTurnRun {
  return {
    chatKey,
    runId,
    active: true,
    availability: null,
    entries: [],
    throughSequence: 0,
    runRevision: 0,
    completeThrough: 0,
  };
}

/**
 * У записей человека есть messageId, у блоков агента assistantMessageId.
 * Это различие устойчиво и после сериализации в истории.
 */
export function isInTurnReceipt(entry: InTurnEntry): entry is InTurnReceipt {
  return typeof (entry as InTurnReceipt).messageId === 'string';
}

/**
 * Ключ включает роль: даже совпавшие строки id человека и агента
 * не превращаются в один элемент ленты.
 */
export function inTurnEntryKey(entry: InTurnEntry): string {
  return isInTurnReceipt(entry)
    ? `user:${entry.messageId}`
    : `assistant:${entry.assistantMessageId}`;
}

/**
 * Поздний SSE или страница GET не откатывает receipt и завершённый ответ.
 * Текст и sequence приёма канонические; обновляется только допустимый статус.
 */
export function mergeInTurnEntry(run: ChatInTurnRun, entry: InTurnEntry): boolean {
  if (!entry || entry.runId !== run.runId || entry.chatKey !== run.chatKey) {
    return false;
  }

  const key = inTurnEntryKey(entry);
  const index = run.entries.findIndex((item) => inTurnEntryKey(item) === key);
  const old = run.entries[index];

  if (old) {
    if (entry.revision < old.revision) {
      return false;
    }

    if (isInTurnReceipt(old) && isInTurnReceipt(entry)) {
      if (entry.revision === old.revision && entry.state !== old.state) {
        return false;
      }
      if (old.text !== entry.text || old.sequence !== entry.sequence) {
        return false;
      }
      if (!canTransition(old.state, entry.state)) {
        return false;
      }
    }

    if (!isInTurnReceipt(old) && old.complete && !isInTurnReceipt(entry) && !entry.complete) {
      return false;
    }

    if (entry.revision === old.revision && JSON.stringify(entry) === JSON.stringify(old)) {
      return false;
    }

    run.entries.splice(index, 1);
  }

  run.entries.push(entry);
  run.entries.sort((left, right) => left.sequence - right.sequence);
  run.throughSequence = Math.max(run.throughSequence, entry.sequence);

  return true;
}

/**
 * Ревизия готовности может прийти позднее новой через другое окно.
 * В таком случае оставляем уже показанное состояние канала.
 */
export function mergeInTurnAvailability(
  run: ChatInTurnRun,
  availability: InTurnAvailability | null | undefined,
): void {
  if (!availability || availability.runId !== run.runId) {
    return;
  }
  if (availability.revision < (run.availability?.revision || 0)) {
    return;
  }

  run.availability = availability;
}

/**
 * Страница всегда обновляет границы журнала, даже если записи уже известны.
 * Признак изменения позволяет вызывающему пропустить только лишнюю проекцию.
 */
export function mergeInTurnPage(run: ChatInTurnRun, page: InTurnPage): boolean {
  let changed = false;

  for (const entry of page.entries || []) {
    if (mergeInTurnEntry(run, entry)) {
      changed = true;
    }
  }

  run.throughSequence = Math.max(run.throughSequence, page.throughSequence || 0);
  run.runRevision = Math.max(run.runRevision, page.runRevision || 0);

  if (page.nextAfterSequence === null) {
    run.completeThrough = Math.max(run.completeThrough, page.throughSequence || 0);
  }

  return changed;
}

/**
 * Локальная отметка обрыва для черновиков запуска, который это окно больше не считает
 * идущим. Ревизию не трогаем: свежая запись сервера обязана перезаписать отметку целиком.
 * Возвращает true, если что-то изменилось.
 */
export function closeOpenDrafts(run: ChatInTurnRun): boolean {
  let changed = false;

  run.entries = run.entries.map((entry) => {
    if (isInTurnReceipt(entry) || entry.complete || entry.abandoned) {
      return entry;
    }

    changed = true;

    return { ...entry, abandoned: true };
  });

  return changed;
}

/**
 * Плоский DTO сравнивается по собственным полям без рекурсивного обхода.
 * Receipt содержит только скаляры; ссылки на тяжёлые steps сравниваются как значения.
 */
function sameFields(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const old = left as Record<string, unknown>;
  const next = right as Record<string, unknown>;
  const keys = Object.keys(old);

  return keys.length === Object.keys(next).length
    && keys.every((key) => Object.hasOwn(next, key) && old[key] === next[key]);
}

/**
 * Повтор страницы сохраняет прежний объект, включая метаданные финального ответа.
 * Новая оболочка receipt с прежними скалярами не делает всю историю изменённой.
 */
function reuseHistoryMessage(old: HistoryMessage | undefined, next: HistoryMessage): HistoryMessage {
  if (!old) {
    return next;
  }

  const keys = Object.keys(next);
  const equal = keys.length === Object.keys(old).length && keys.every((key) => (
    Object.hasOwn(old, key)
      && (key === 'receipt' ? sameFields(old[key], next[key]) : old[key] === next[key])
  ));

  return equal ? old : next;
}

/**
 * Один проход по истории заменяет повторный поиск для каждого блока запуска.
 * В каждой роли сохраняется первое совпадение, как у прежнего Array.find.
 */
function indexHistoryMessages(messages: HistoryMessage[], runId: string): HistoryMessageIndex {
  const receipts = new Map<string, HistoryMessage>();
  const assistants = new Map<string, HistoryMessage>();

  for (const message of messages) {
    if (message.runId !== runId) {
      continue;
    }

    const messageId = message.messageId;
    const assistantMessageId = message.assistantMessageId;

    if (typeof messageId === 'string' && !receipts.has(messageId)) {
      receipts.set(messageId, message);
    }
    if (typeof assistantMessageId === 'string' && !assistants.has(assistantMessageId)) {
      assistants.set(assistantMessageId, message);
    }
  }

  return { receipts, assistants };
}

/**
 * Запись журнала дополняет существующее сообщение, сохраняя метаданные финала.
 * Поля текста, порядка и доставки всегда берутся из подтверждённой записи сервера.
 */
function historyMessage(
  entry: InTurnEntry,
  run: ChatInTurnRun,
  previous: HistoryMessageIndex,
): HistoryMessage {
  if (isInTurnReceipt(entry)) {
    const old = previous.receipts.get(entry.messageId);

    return reuseHistoryMessage(old, {
      ...old,
      role: 'user',
      kind: 'in-turn',
      text: entry.text,
      ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      messageId: entry.messageId,
      runId: entry.runId,
      parentTurnId: entry.parentTurnId || run.parentTurnId,
      sequence: entry.sequence,
      receipt: entry,
      sentAt: entry.sentAt || entry.acceptedAt,
      serverCanonical: true,
    });
  }

  const old = previous.assistants.get(entry.assistantMessageId);

  return reuseHistoryMessage(old, {
    ...old,
    role: 'assistant',
    kind: 'assistant-block',
    text: entry.text,
    assistantMessageId: entry.assistantMessageId,
    runId: entry.runId,
    parentTurnId: run.parentTurnId,
    sequence: entry.sequence,
    revision: entry.revision,
    complete: entry.complete,
    serverCanonical: true,
  });
}

/**
 * Группа уточнений и завершённых блоков занимает место перед финалом своего запуска.
 * Локальный индекс сохраняет прежние сообщения без повторных обходов всей истории.
 */
export function materializeInTurnMessages(
  messages: HistoryMessage[],
  run: ChatInTurnRun,
): HistoryMessage[] {
  const entries = run.entries
    .filter((entry) => isInTurnReceipt(entry) || (entry.complete && !!entry.text.trim()));

  if (!entries.length) {
    return messages;
  }

  const previous = indexHistoryMessages(messages, run.runId);
  const group = entries.map((entry) => historyMessage(entry, run, previous));
  const kept = messages.filter((message) => message.runId !== run.runId
    || (message.kind !== 'in-turn' && message.kind !== 'assistant-block'));
  const parent = kept.findIndex((message) => message.role === 'user'
    && message.turnId === run.parentTurnId);
  const final = kept.findIndex((message) => message.runId === run.runId
    && message.role === 'assistant');
  const at = final >= 0 ? final : (parent >= 0 ? parent + 1 : kept.length);

  kept.splice(at, 0, ...group);

  return kept.length === messages.length && kept.every((message, index) => message === messages[index])
    ? messages
    : kept;
}

/**
 * Финал из pending и синхронного HTTP-ответа дополняет уже видимый блок по одному правилу.
 * Поиск ограничен запуском: одинаковый id блока другого хода не поглощает новый ответ.
 */
export function applyAssistantFinal(
  messages: HistoryMessage[],
  result: AssistantFinalIdentity,
  final: HistoryMessage,
): void {
  const finalId = result.finalAssistantMessageId || result.assistantMessageId;
  const visible = result.runId && finalId
    ? messages.find((message) => message.runId === result.runId
      && message.assistantMessageId === finalId)
    : null;
  const message = {
    ...final,
    ...(Array.isArray(final.steps) ? { steps: ownHistorySteps(final.steps) } : {}),
    ...(result.runId ? { runId: result.runId } : {}),
    ...(finalId ? { assistantMessageId: finalId, finalAssistantMessageId: finalId } : {}),
  };

  if (visible) {
    Object.assign(visible, message);
  } else {
    messages.push(message);
  }
}

/**
 * Список блоков, уже нарисованных как сообщения, нужен ленте шагов.
 * Только их текстовые шаги скрываются, сами шаги остаются в хранилище.
 */
export function displayedAssistantIds(run: ChatInTurnRun | null | undefined): string[] {
  return (run?.entries || [])
    .filter((entry): entry is InTurnAssistantBlock => !isInTurnReceipt(entry))
    .filter((block) => !!block.text.trim())
    .map((block) => block.assistantMessageId);
}
