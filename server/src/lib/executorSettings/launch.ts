// Общий prepare использует один контейнер и явно выбранный consumer запуска.
// Служебный run и runUntrusted не наследуют этот путь через общее чтение prefs.

import type { ExecutorAdapter } from '../executors/index.ts';
import type { AcceptedNativeSetting, PreparedNativeSettings } from './types.ts';
import { ProviderSettingsCatalogCache } from './catalog.ts';
import { nativeSettingsContext } from './context.ts';
import { readNativeSettingsStorage } from './overrides.ts';
import { flattenNativeSettings, validateNativeSetting } from './validation.ts';
import { settingsFingerprint } from './fingerprint.ts';
import { NativeSettingsError } from './errors.ts';
import type { SettingsConsumer } from '../../../../shared/chat/providerSettingsContracts.ts';

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
export async function prepareNativeSettings(
  adapter: Pick<ExecutorAdapter, 'id' | 'nativeSettings'> & Partial<Pick<ExecutorAdapter, 'bin'>>,
  config: unknown,
  cwd: string,
  allSaved: unknown,
  {
    consumer = 'chat',
    cache = chatCatalogCache,
    mode,
  }: {
    consumer?: SettingsConsumer;
    cache?: ProviderSettingsCatalogCache;
    mode?: string;
  } = {},
): Promise<PreparedNativeSettings | undefined> {
  const storage = readNativeSettingsStorage(allSaved, adapter.id);

  if (Object.keys(storage.overrides).length === 0) {
    return undefined;
  }

  const capability = adapter.nativeSettings;

  if (consumer === 'pipeline' && !capability?.consumers?.includes('pipeline')) {
    return undefined;
  }

  if (!capability) {
    throw new NativeSettingsError('settings_unavailable', 503, 'Источник нативных настроек недоступен');
  }

  const baseContext = await nativeSettingsContext(adapter, config, undefined, consumer);

  if (mode) {
    baseContext.mode = mode;
  }

  const baseline = await cache.read(capability, baseContext, { refresh: true });
  const available = (read: typeof baseline) =>
    read.snapshot && read.schemaRevision && read.state !== 'stale' && read.state !== 'unavailable';

  if (!available(baseline)) {
    throw new NativeSettingsError('settings_unavailable', 503, 'Нативные настройки не удалось перепроверить');
  }

  const selected = Object.entries(storage.overrides).filter(([fieldId]) => {
    const field = flattenNativeSettings(baseline.fields).find((field) => field.id === fieldId);

    if (consumer !== 'pipeline') {
      return field?.consumerSupport?.chat?.state !== 'unsupported';
    }

    const support = field?.consumerSupport?.pipeline;

    if (!support || support.state === 'unverified') {
      throw new NativeSettingsError(
        'native_settings_unverified', 503, 'Совместимость overrides с ACP не подтверждена', [fieldId],
      );
    }

    return support.state === 'verified';
  });
  const active = selected.filter(
    ([fieldId, entry]) =>
      !validateNativeSetting(baseline.fields, fieldId, entry.value, selected.map(([, value]) => value)),
  );

  if (active.length === 0) {
    return undefined;
  }

  const context = await nativeSettingsContext(adapter, config, cwd, consumer);

  if (mode) {
    context.mode = mode;
  }

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
    const support = flattenNativeSettings(read.fields)
      .find((field) => field.id === fieldId)?.consumerSupport?.[consumer];

    if (consumer === 'pipeline' && support?.state !== 'verified') {
      return [{ fieldId, message: 'Совместимость поля с ACP не подтверждена в рабочей папке' }];
    }

    const invalid = validateNativeSetting(
      read.fields,
      fieldId,
      entry.value,
      active.map(([, entry]) => entry),
    );

    const field = flattenNativeSettings(read.fields).find((field) => field.id === fieldId);
    const profileInvalid = Object.entries(read.snapshot?.consumerFields ?? {}).some(([profile, fields]) =>
      field?.consumerSupport?.[profile as SettingsConsumer]?.state === 'verified' && fields &&
      validateNativeSetting(fields, fieldId, entry.value, active.map(([, value]) => value)) !== null);

    return invalid || profileInvalid
      ? [{
        fieldId,
        message: invalid?.message || 'Значение несовместимо со схемой одного из consumers',
      }] : [];
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

/**
 * Совместимая обёртка сохраняет старые callers и их отдельный chat consumer.
 * Другие providers не получают pipeline settings без явной capability.
 */
export function prepareChatNativeSettings(
  adapter: Pick<ExecutorAdapter, 'id' | 'nativeSettings'> & Partial<Pick<ExecutorAdapter, 'bin'>>,
  config: unknown,
  cwd: string,
  allSaved: unknown,
  cache = chatCatalogCache,
): Promise<PreparedNativeSettings | undefined> {
  return prepareNativeSettings(adapter, config, cwd, allSaved, { consumer: 'chat', cache });
}
