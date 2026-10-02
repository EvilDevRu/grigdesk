export const HISTORY_STEP_REUSE_PROTOCOL = 1;
export const HISTORY_STEP_REUSE_ROUTE = '/api/chat/store/chat/step-reuse';

export interface HistoryStepRef {
  messageIndex: number;
  sourceIndex: number;
  expectedKey: string;
  expectedLength: number;
}

export interface HistoryStepReuseRequest {
  protocol: 1;
  baseRevision: number;
  refs: HistoryStepRef[];
}

export interface HistoryStepReuseAck {
  protocol: 1;
  revision: number;
  confirmed: HistoryStepRef[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function position(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Индексы назначения и источника уникальны; неизвестные поля не расширяют протокол молча.
 * Декодер не читает тела steps и не пытается угадывать сообщения по одному тексту.
 */
function decodeRefs(value: unknown): HistoryStepRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const messages = new Set<number>();
  const sources = new Set<number>();
  const refs: HistoryStepRef[] = [];

  for (const ref of value) {
    if (!record(ref) || Object.keys(ref).length !== 4 ||
      !position(ref.messageIndex) || !position(ref.sourceIndex) ||
      !position(ref.expectedLength) || typeof ref.expectedKey !== 'string' || !ref.expectedKey ||
      messages.has(ref.messageIndex) || sources.has(ref.sourceIndex)) {
      return null;
    }

    messages.add(ref.messageIndex);
    sources.add(ref.sourceIndex);
    refs.push({
      messageIndex: ref.messageIndex,
      sourceIndex: ref.sourceIndex,
      expectedKey: ref.expectedKey,
      expectedLength: ref.expectedLength,
    });
  }

  return refs;
}

/**
 * Сокращённый запрос обязан содержать ссылки и массив сообщений без steps в их позициях.
 * Очистка и обычная полная запись проходят только через прежний маршрут.
 */
export function decodeHistoryStepReuseRequest(
  value: unknown,
  messages: unknown,
): HistoryStepReuseRequest | null {
  if (!record(value) || Object.keys(value).length !== 3 ||
    value.protocol !== HISTORY_STEP_REUSE_PROTOCOL || !positiveRevision(value.baseRevision) ||
    !Array.isArray(messages)) {
    return null;
  }

  const refs = decodeRefs(value.refs);

  if (!refs?.length || refs.length > messages.length || refs.some((ref) => (
      !record(messages[ref.messageIndex]) || Object.hasOwn(messages[ref.messageIndex], 'steps')
    ))) {
    return null;
  }

  return {
    protocol: 1,
    baseRevision: value.baseRevision,
    refs
  };
}

/**
 * ACK подтверждает только перечисленные позиции итоговой durable-истории.
 * Пустое подтверждение допустимо: клиент безопасно останется на полной передаче.
 */
export function decodeHistoryStepReuseAck(value: unknown): HistoryStepReuseAck | null {
  if (!record(value) || Object.keys(value).length !== 3 ||
    value.protocol !== HISTORY_STEP_REUSE_PROTOCOL || !positiveRevision(value.revision)) {
    return null;
  }

  const confirmed = decodeRefs(value.confirmed);

  return confirmed ? {
    protocol: 1,
    revision: value.revision,
    confirmed
  } : null;
}
