// Контейнер overrides принадлежит Cockpit и никогда не становится нативным ключом.
// Короткая синхронная транзакция сохраняет соседей и проверяет ревизию всего provider.

import type { ProviderSettingsOverrideRequest } from '../../../../shared/providerSettingsContracts.ts';
import { decodeSettingsJson } from '../../../../shared/providerSettingsContracts.ts';
import type { PrefsStore } from '../prefsStore.ts';
import type { NativeSettingsStorage, NormalizedSettingNode } from './types.ts';
import { NativeSettingsError } from './errors.ts';
import { flattenNativeSettings, validateNativeSetting } from './validation.ts';
import { canonicalSettingsJson } from './fingerprint.ts';

export interface OverrideCatalog {
  fields: readonly NormalizedSettingNode[];
  schemaRevision: string | null;
  state: 'ready' | 'partial' | 'stale' | 'unavailable';
}

/**
 * Неизвестный формат или повреждённый контейнер сохраняется до исправления человеком.
 * Отсутствие контейнера — единственный случай начальной ревизии ноль.
 */
export function readNativeSettingsStorage(all: unknown, providerId: string): NativeSettingsStorage {
  const settings = all === undefined ? {} : all;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  if (!isRecord(settings) || (Object.hasOwn(settings, providerId) && !isRecord(settings[providerId]))) {
    throw new NativeSettingsError('settings_storage_invalid', 500, 'Контейнер нативных настроек повреждён');
  }

  const container = (settings[providerId] as Record<string, unknown> | undefined)?.nativeSettings;

  if (container === undefined) {
    return {
      format: 1,
      revision: 0,
      overrides: {},
    };
  }

  const storage = container as NativeSettingsStorage;
  const valid =
    storage &&
    storage.format === 1 &&
    Number.isSafeInteger(storage.revision) &&
    storage.revision >= 0 &&
    storage.overrides !== null &&
    typeof storage.overrides === 'object' &&
    !Array.isArray(storage.overrides);

  if (
    !valid ||
    Object.entries(storage.overrides).some(
      ([id, entry]) =>
        !entry ||
        !Array.isArray(entry.path) ||
        entry.path.length === 0 ||
        entry.path.some(
          (part) => typeof part !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(part),
        ) ||
        JSON.stringify(entry.path) !== id ||
        !Object.hasOwn(entry, 'value'),
    )
  ) {
    throw new NativeSettingsError('settings_storage_invalid', 500, 'Контейнер нативных настроек повреждён');
  }

  try {
    return decodeSettingsJson(storage) as unknown as NativeSettingsStorage;
  } catch {
    throw new NativeSettingsError('settings_storage_invalid', 500, 'Контейнер нативных настроек повреждён');
  }
}

/**
 * Проверенный выбор меняет только свой путь и увеличивает ревизию контейнера.
 * Результат сообщает сохранение, а не применение в работающем разговоре.
 */
export function updateNativeSettingsOverride(
  prefs: PrefsStore,
  providerId: string,
  request: ProviderSettingsOverrideRequest,
  catalog: OverrideCatalog,
  isCurrent: () => boolean = () => true,
): { changed: boolean; storage: NativeSettingsStorage } {
  let changed = false;
  let storage: NativeSettingsStorage = {
    format: 1,
    revision: 0,
    overrides: {},
  };

  prefs.updateProviderSettings((current) => {
    storage = readNativeSettingsStorage(current, providerId);

    if (String(storage.revision) !== request.revision) {
      throw new NativeSettingsError('revision_conflict', 409, 'Настройки изменились; перечитайте каталог');
    }

    if (request.operation === 'set') {
      if (catalog.state !== 'ready' && catalog.state !== 'partial') {
        throw new NativeSettingsError('settings_unavailable', 503, 'Источник настроек недоступен');
      }

      if (!isCurrent()) {
        throw new NativeSettingsError('revision_conflict', 409, 'Каталог изменился; перечитайте настройки');
      }

      if (catalog.schemaRevision !== request.schemaRevision) {
        throw new NativeSettingsError(
          'schema_conflict',
          409,
          'Описание настроек изменилось; перечитайте каталог',
        );
      }

      const invalid = validateNativeSetting(
        catalog.fields,
        request.fieldId,
        request.value,
        Object.values(storage.overrides).filter((entry) => JSON.stringify(entry.path) !== request.fieldId),
      );

      if (invalid) {
        const status = invalid.code === 'unknown_field' ? 400 : invalid.code === 'readonly_field' ? 403 : 422;

        throw new NativeSettingsError(invalid.code, status, invalid.message);
      }

      const field = flattenNativeSettings(catalog.fields).find((item) => item.id === request.fieldId)!;
      const next = { path: [...field.path], value: structuredClone(request.value) };

      changed = canonicalSettingsJson(storage.overrides[request.fieldId]) !== canonicalSettingsJson(next);
      storage.overrides[request.fieldId] = next;
    } else {
      changed = Object.hasOwn(storage.overrides, request.fieldId);
      delete storage.overrides[request.fieldId];
    }

    if (!changed) {
      return current;
    }

    if (storage.revision >= Number.MAX_SAFE_INTEGER) {
      throw new NativeSettingsError('settings_storage_invalid', 500, 'Ревизия настроек исчерпана');
    }

    storage.revision += 1;

    return {
      ...current,
      [providerId]: { ...(current[providerId] as object), nativeSettings: storage },
    };
  });

  return { changed, storage };
}
