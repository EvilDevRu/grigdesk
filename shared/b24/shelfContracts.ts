// Контракт полки задач. Полка живёт на сервере и привязана к портальной учётке, поэтому
// её снимок — это не локальное состояние вкладки, а ответ сети: пока форма не проверена,
// это недоверенные данные.
//
// Снимок записи (`analysis`, `pipeline`, `b24`) ездит в обе стороны: сервер отдаёт его в
// списке, а клиент возвращает при постановке задачи на полку. Поэтому у него один
// декодер на оба направления — разойтись они не имеют права.

import { contractDecoders } from '../lib/contractDecoders.ts';
import type { Decoder } from '../lib/contractDecoders.ts';

export class ShelfContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ полки: поле ${path}`);
    this.name = 'ShelfContractError';
  }
}

function failShelf(path: string): never {
  throw new ShelfContractError(path);
}

const {
  boolean,
  listOf,
  nullable,
  objectOf,
  oneOf,
  text,
  wholeNumber,
} = contractDecoders(failShelf);

// Причина, по которой задача лежит на полке: она же выбирает текст ожидания.
const reason = oneOf('manual', 'analysis', 'pipeline', 'comments');

// Состояние оценки: незнакомое значение не должно тихо включать запасную ветку показа.
const analysisState = oneOf('queued', 'running', 'done', 'finished', 'failed', 'interrupted');

/**
 * Время оценки — миллисекунды: сервер триажа отдаёт их числом. Записи прошлого
 * формата держат ISO-строку, и читать её всё ещё нужно — иначе полка человека
 * отказала бы целиком на первом же старом снимке. Наружу время уходит числом,
 * поэтому две подряд неудачные оценки больше не выглядят одной и той же.
 */
const moment: Decoder<number> = (value, path) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return failShelf(path);
  }

  return parsed;
};

const analysisSnapshot = objectOf({
  state: analysisState,
  queuedAt: nullable(moment),
  startedAt: nullable(moment),
  finishedAt: nullable(moment),
  generatedAt: nullable(text),
});

const pipelineSnapshot = objectOf({
  attempt: nullable(text),
  daemon: nullable(text),
  result: nullable(text),
  stall: nullable(text),
  gateKnown: boolean,
  gate: nullable(text),
});

const b24Snapshot = objectOf({
  present: boolean,
  status: nullable(text),
  statusKind: nullable(text),
  unread: wholeNumber,
});

const entrySnapshot = objectOf({
  analysis: nullable(analysisSnapshot),
  pipeline: nullable(pipelineSnapshot),
  b24: nullable(b24Snapshot),
});

const shelfEntry = objectOf({
  taskId: text,
  title: text,
  addedAt: text,
  reason,
  snapshot: entrySnapshot,
});

const shelfState = objectOf({
  scope: text,
  revision: wholeNumber,
  entries: listOf(shelfEntry),
});

export type ShelfReason = ReturnType<typeof reason>;
export type ShelfAnalysisState = ReturnType<typeof analysisState>;
export type ShelfAnalysisSnapshot = ReturnType<typeof analysisSnapshot>;
export type ShelfPipelineSnapshot = ReturnType<typeof pipelineSnapshot>;
export type ShelfB24Snapshot = ReturnType<typeof b24Snapshot>;
export type ShelfEntrySnapshot = ReturnType<typeof entrySnapshot>;
export type ShelfEntry = ReturnType<typeof shelfEntry>;
export type ShelfState = ReturnType<typeof shelfState>;

// Тело постановки на полку. `createIfMissing` разделяет два разных действия: ensure
// (ручная и автоматическая постановка) и acknowledge уже лежащей записи.
export interface ShelfPutInput {
  title: string;
  reason: ShelfReason;
  snapshot: ShelfEntrySnapshot;
  createIfMissing: boolean;
}

export function parseShelfState(value: unknown): ShelfState {
  return shelfState(value, 'shelf');
}

export function parseShelfEntrySnapshot(value: unknown): ShelfEntrySnapshot {
  return entrySnapshot(value, 'shelfSnapshot');
}
