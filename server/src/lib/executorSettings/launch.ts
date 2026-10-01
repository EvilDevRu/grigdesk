// Только чат превращает сохранённый контейнер в подготовленный план запуска.
// Служебный run и runUntrusted не наследуют этот путь через общее чтение prefs.

import type { ExecutorAdapter } from '../executors/index.ts';
import type { AcceptedNativeSetting, PreparedNativeSettings } from './types.ts';
import { ProviderSettingsCatalogCache } from './catalog.ts';
import { nativeSettingsContext } from './context.ts';
import { readNativeSettingsStorage } from './overrides.ts';
import { flattenNativeSettings, validateNativeSetting } from './validation.ts';
import { settingsFingerprint } from './fingerprint.ts';
import { NativeSettingsError } from './errors.ts';

const chatCatalogCache = new ProviderSettingsCatalogCache();

/**
 * Снимок не допускает изменения payload или accepted после асинхронной подготовки.
 * Изменение prefs во время открытия относится только к следующему ходу.
 */
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      immutable(child);
    }

    Object.freeze(value);
  }

  return value;
}

/**
 * Выбранный снимок prefs не перечитывается во время подготовки. Источник сверяется
 * с фактической папкой чата, а изменение prefs затронет только следующий ход.
 */
export async function prepareChatNativeSettings(
  adapter: Pick<ExecutorAdapter, 'id' | 'nativeSettings'> & Partial<Pick<ExecutorAdapter, 'bin'>>,
  config: unknown,
  cwd: string,
  allSaved: unknown,
  cache = chatCatalogCache,
): Promise<PreparedNativeSettings | undefined> {
  const storage = readNativeSettingsStorage(allSaved, adapter.id);

  if (Object.keys(storage.overrides).length === 0) {
    return undefined;
  }

  const capability = adapter.nativeSettings;

  if (!capability) {
    throw new NativeSettingsError('settings_unavailable', 503, 'Источник нативных настроек недоступен');
  }

  const baseContext = await nativeSettingsContext(adapter, config);
  const baseline = await cache.read(capability, baseContext, { refresh: true });
  const available = (read: typeof baseline) =>
    read.snapshot && read.schemaRevision && read.state !== 'stale' && read.state !== 'unavailable';

  if (!available(baseline)) {
    throw new NativeSettingsError('settings_unavailable', 503, 'Нативные настройки не удалось перепроверить');
  }

  const active = Object.entries(storage.overrides).filter(
    ([fieldId, entry]) =>
      !validateNativeSetting(baseline.fields, fieldId, entry.value, Object.values(storage.overrides)),
  );

  if (active.length === 0) {
    return undefined;
  }

  const context = await nativeSettingsContext(adapter, config, cwd);
  const read =
    settingsFingerprint(context) === settingsFingerprint(baseContext)
      ? baseline
      : await cache.read(capability, context, { refresh: true });

  if (!available(read)) {
    throw new NativeSettingsError(
      'settings_unavailable',
      503,
      'Нативные настройки папки не удалось перепроверить',
    );
  }

  const incompatible = active.flatMap(([fieldId, entry]) => {
    const invalid = validateNativeSetting(
      read.fields,
      fieldId,
      entry.value,
      active.map(([, entry]) => entry),
    );

    return invalid ? [{ fieldId, message: invalid.message }] : [];
  });

  if (incompatible.length) {
    throw new NativeSettingsError(
      'native_settings_incompatible',
      409,
      'Переопределения несовместимы с настройками папки чата',
      incompatible.map((item) => item.fieldId),
      incompatible,
    );
  }

  const accepted: AcceptedNativeSetting[] = active
    .flatMap(([fieldId, entry]) => {
      const field = flattenNativeSettings(read.fields).find((item) => item.id === fieldId);

      return field &&
        !validateNativeSetting(read.fields, fieldId, entry.value, Object.values(storage.overrides))
        ? [
            {
              ...entry,
              fieldId,
              channelId: field.channelId,
            },
          ]
        : [];
    })
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
  const plan = await capability.prepare(context, read.snapshot!, accepted, {
    signal: AbortSignal.timeout(15_000),
  });
  const contextFingerprint = settingsFingerprint(context);

  return immutable(
    structuredClone({
      ...plan,
      providerId: adapter.id,
      contextFingerprint,
      schemaRevision: read.schemaRevision!,
      storageRevision: String(storage.revision),
      accepted: structuredClone(accepted),
      fingerprint: settingsFingerprint({ context, accepted }),
    }),
  );
}
