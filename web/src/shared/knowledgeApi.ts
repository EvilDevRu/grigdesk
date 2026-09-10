import { api } from './apiClient.ts';
import {
  KnowledgeContractError,
  parseKnowledgeImportPreview,
  parseKnowledgeImportResult,
  parseKnowledgeList,
  parseKnowledgeMapsResult,
  parseKnowledgeRecord,
  parseKnowledgeRemoval,
  parseKnowledgeSearch,
} from '../../../shared/knowledgeContracts.ts';
import type {
  KnowledgeImportResolution,
  KnowledgeListFilters,
  KnowledgeRecordInput,
  KnowledgeSearchFilters,
} from '../../../shared/knowledgeContracts.ts';

export interface KnowledgeBackupFile {
  blob: Blob;
  filename: string;
}

/**
 * Фильтры уезжают в адрес только заполненными: пустое поле не должно превращаться в
 * условие «проект равен пустой строке» и обнулять список.
 */
function queryString(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value) {
      params.set(key, value);
    }
  }

  const suffix = params.toString();

  return suffix ? `?${suffix}` : '';
}

// Файл резервной копии уезжает тем же multipart-полем и в предпросмотр, и в применение.
function backupForm(file: File): FormData {
  const formData = new FormData();

  formData.append('file', file);

  return formData;
}

/**
 * Единственная граница сети раздела «Знания». Общий клиент знает HTTP и сессию, а
 * форму ответа подтверждает контракт: запись показывается человеку как проверенный
 * факт, а импорт и удаление необратимы, и решать по непроверенному JSON нельзя.
 */
export const knowledgeApi = {
  async list(filters: KnowledgeListFilters = {}) {
    const suffix = queryString({ project: filters.project, tag: filters.tag });
    const value: unknown = await api.get(`/api/knowledge${suffix}`);

    return parseKnowledgeList(value);
  },

  async search(filters: KnowledgeSearchFilters) {
    const suffix = queryString({
      q: filters.query,
      project: filters.project,
      tag: filters.tag,
    });
    const value: unknown = await api.get(`/api/knowledge/search${suffix}`);

    return parseKnowledgeSearch(value).items;
  },

  async read(id: string) {
    const value: unknown = await api.get(`/api/knowledge/${encodeURIComponent(id)}`);

    return parseKnowledgeRecord(value).record;
  },

  async create(input: KnowledgeRecordInput) {
    const value: unknown = await api.post('/api/knowledge', input);

    return parseKnowledgeRecord(value).record;
  },

  async update(id: string, input: KnowledgeRecordInput, expectedRevision: number) {
    const value: unknown = await api.put(`/api/knowledge/${encodeURIComponent(id)}`, {
      ...input,
      expectedRevision,
    });

    return parseKnowledgeRecord(value).record;
  },

  async remove(id: string, expectedRevision: number) {
    const path = `/api/knowledge/${encodeURIComponent(id)}`;
    const value: unknown = await api.del(path, { expectedRevision });

    return parseKnowledgeRemoval(value);
  },

  /**
   * Резервная копия приходит бинарным телом, а не JSON: проверять её содержимое здесь
   * нечем, но подмена ответа на что-то кроме файла обязана остановиться на границе.
   */
  async exportBackup(): Promise<KnowledgeBackupFile> {
    const value: unknown = await api.download('/api/knowledge/backup/export');
    const source = value !== null && typeof value === 'object'
      ? value as { blob?: unknown; filename?: unknown }
      : {};

    if (!(source.blob instanceof Blob)) {
      throw new KnowledgeContractError('backup.blob');
    }

    return {
      blob: source.blob,
      filename: typeof source.filename === 'string' ? source.filename : '',
    };
  },

  async previewImport(file: File) {
    const value: unknown = await api.upload('/api/knowledge/backup/import/preview', backupForm(file));

    return parseKnowledgeImportPreview(value);
  },

  /**
   * Применение уходит с увиденным hash снимка: сервер сверит его сам и откажет, если
   * файл или база успели измениться после предпросмотра.
   */
  async applyImport(file: File, snapshotHash: string, resolutions: KnowledgeImportResolution[]) {
    const formData = backupForm(file);

    formData.append('snapshotHash', snapshotHash);
    formData.append('resolutions', JSON.stringify(resolutions));

    const value: unknown = await api.upload('/api/knowledge/backup/import/apply', formData);

    return parseKnowledgeImportResult(value);
  },

  async refreshMaps() {
    const value: unknown = await api.post('/api/knowledge/maps/refresh');

    return parseKnowledgeMapsResult(value);
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Текст отказа для человека. Общий клиент кладёт тело ответа в `data`: формулировка
 * сервера точнее всего, а обрыв сети приходит без тела, и тогда остаётся сообщение
 * самой ошибки.
 */
export function knowledgeErrorMessage(
  error: unknown,
  fallback = 'Не удалось выполнить операцию.',
): string {
  const data = asRecord(asRecord(error).data);
  const detail = typeof data.message === 'string' ? data.message : '';
  const message = typeof asRecord(error).message === 'string' ? String(asRecord(error).message) : '';

  return detail || message || fallback;
}

/**
 * Машинный код отказа. По нему раздел отличает выключенный плагин от поломки базы:
 * выключение — штатное состояние, и показывать его как ошибку неверно.
 */
export function knowledgeErrorCode(error: unknown): string {
  const code = asRecord(asRecord(error).data).error;

  return typeof code === 'string' ? code : '';
}
