import type { DiffPreferences } from './codeDiffModel';

const STORAGE_KEY = 'grigdesk-code-diff-preferences-v1';
const defaults: DiffPreferences = {
  version: 1,
  collapse: true,
  context: '3',
  detail: 'word',
  whitespace: 'all',
  renderWhitespace: false,
  sync: true,
  align: true,
};

/**
 * Принимает только известную версию и значения настроек текущего устройства.
 * Повреждённое или недоступное хранилище не препятствует открытию сравнения.
 */
export function readDiffPreferences(): DiffPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');

    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) {
      return {
        ...defaults,
        whitespace: localStorage.getItem('grigdesk-diff-ws') === '1' ? 'trim' : 'all',
      };
    }

    const data = value as Record<string, unknown>;

    return {
      ...defaults,
      collapse: typeof data.collapse === 'boolean' ? data.collapse : defaults.collapse,
      context: data.context === '10' || data.context === 'all' ? data.context : '3',
      detail: data.detail === 'line' || data.detail === 'char' ? data.detail : 'word',
      whitespace: data.whitespace === 'trim' || data.whitespace === 'ignore-all' ? data.whitespace : 'all',
      renderWhitespace: data.renderWhitespace === true,
      sync: typeof data.sync === 'boolean' ? data.sync : true,
      align: typeof data.align === 'boolean' ? data.align : true,
    };
  } catch {
    return { ...defaults };
  }
}

/**
 * Сохраняет проверенное состояние одним versioned объектом без содержимого файлов.
 * Ошибка storage оставляет настройки текущего открытого просмотра работоспособными.
 */
export function storeDiffPreferences(preferences: DiffPreferences): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));

    return true;
  } catch {
    return false;
  }
}
