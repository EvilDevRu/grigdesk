// Контракт плагина «Знания». База живёт в отдельном worker-е SQLite, и до раздела её
// ответы доезжают обычным сетевым JSON: пока форма не подтверждена, это недоверенные
// данные, а не запись знаний.
//
// Порядок полей в записи повторяет порядок ответа сервера намеренно. Предпросмотр
// импорта показывает человеку сам JSON обеих версий записи, и перестановка ключей
// изменила бы то, что он сравнивает глазами.

import { contractDecoders } from './contractDecoders.ts';

export class KnowledgeContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ плагина «Знания»: поле ${path}`);
    this.name = 'KnowledgeContractError';
  }
}

const {
  listOf,
  nullable,
  objectOf,
  oneOf,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new KnowledgeContractError(path);
});

// Происхождение записи заполняет сервер: кто и каким каналом её положил.
const provenance = objectOf({
  actor: text,
  channel: text,
  ref: text,
});

const knowledgeRecord = objectOf({
  id: text,
  project: text,
  repository: text,
  kind: text,
  title: text,
  body: text,
  tags: listOf(text),
  updatedAt: text,
  revision: wholeNumber,
  provenance: nullable(provenance),
});

// Находка поиска — не запись: у неё есть фрагмент совпадения и нет тела.
const searchItem = objectOf({
  id: text,
  title: text,
  tags: listOf(text),
  fragment: text,
});

const facets = objectOf({
  projects: listOf(text),
  tags: listOf(text),
});

const listResponse = objectOf({
  items: listOf(knowledgeRecord),
  facets,
});
const searchResponse = objectOf({ items: listOf(searchItem) });
const recordResponse = objectOf({ record: knowledgeRecord });

// Ответ удаления: сервер обязан прислать именно true, а не что-нибудь истинное.
const removalResponse = objectOf({
  deleted: oneOf(true),
  id: text,
});

// Запись из файла резервной копии происхождения не несёт: экспорт его не выгружает.
const importedRecord = objectOf({
  id: text,
  title: text,
  body: text,
  tags: listOf(text),
  kind: text,
  project: text,
  repository: text,
  revision: wholeNumber,
  updatedAt: text,
});

const importConflict = objectOf({
  id: text,
  title: text,
  baseRevision: wholeNumber,
  currentRevision: wholeNumber,
  changedFields: listOf(text),
  incoming: importedRecord,
  current: knowledgeRecord,
});

const importPreview = objectOf({
  snapshotHash: text,
  summary: objectOf({
    create: wholeNumber,
    update: wholeNumber,
    unchanged: wholeNumber,
    conflict: wholeNumber,
    targetOnly: wholeNumber,
  }),
  conflicts: listOf(importConflict),
});

const importResult = objectOf({
  created: wholeNumber,
  updated: wholeNumber,
  unchanged: wholeNumber,
  keptCurrent: wholeNumber,
  overwritten: wholeNumber,
  targetOnly: wholeNumber,
  total: wholeNumber,
});

const mapsResult = objectOf({
  recordCount: wholeNumber,
  mapCount: wholeNumber,
  mapBytes: wholeNumber,
});

export type KnowledgeProvenance = ReturnType<typeof provenance>;
export type KnowledgeRecord = ReturnType<typeof knowledgeRecord>;
export type KnowledgeSearchItem = ReturnType<typeof searchItem>;
export type KnowledgeFacets = ReturnType<typeof facets>;
export type KnowledgeListResponse = ReturnType<typeof listResponse>;
export type KnowledgeSearchResponse = ReturnType<typeof searchResponse>;
export type KnowledgeRecordResponse = ReturnType<typeof recordResponse>;
export type KnowledgeRemovalResponse = ReturnType<typeof removalResponse>;
export type KnowledgeImportedRecord = ReturnType<typeof importedRecord>;
export type KnowledgeImportConflict = ReturnType<typeof importConflict>;
export type KnowledgeImportPreview = ReturnType<typeof importPreview>;
export type KnowledgeImportSummary = KnowledgeImportPreview['summary'];
export type KnowledgeImportResult = ReturnType<typeof importResult>;
export type KnowledgeMapsResult = ReturnType<typeof mapsResult>;

// Решение человека по конфликту импорта: других значений сервер не принимает.
export type KnowledgeImportDecision = 'keep-current' | 'use-import';

export interface KnowledgeRecordInput {
  project: string;
  repository: string;
  kind: string;
  title: string;
  body: string;
  tags: string[];
}

export interface KnowledgeListFilters {
  project?: string;
  tag?: string;
}

export interface KnowledgeSearchFilters extends KnowledgeListFilters {
  query: string;
}

export interface KnowledgeImportResolution {
  id: string;
  decision: KnowledgeImportDecision;
  expectedCurrentRevision: number;
}

export function parseKnowledgeList(value: unknown): KnowledgeListResponse {
  return listResponse(value, 'list');
}

export function parseKnowledgeSearch(value: unknown): KnowledgeSearchResponse {
  return searchResponse(value, 'search');
}

export function parseKnowledgeRecord(value: unknown): KnowledgeRecordResponse {
  return recordResponse(value, 'record');
}

export function parseKnowledgeRemoval(value: unknown): KnowledgeRemovalResponse {
  return removalResponse(value, 'removal');
}

export function parseKnowledgeImportPreview(value: unknown): KnowledgeImportPreview {
  return importPreview(value, 'importPreview');
}

export function parseKnowledgeImportResult(value: unknown): KnowledgeImportResult {
  return importResult(value, 'importResult');
}

export function parseKnowledgeMapsResult(value: unknown): KnowledgeMapsResult {
  return mapsResult(value, 'mapsResult');
}
