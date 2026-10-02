// Адаптер привязывает серверную конфигурацию к контексту через WeakMap.
// Конфигурация, ключи доступа и временные пути не входят в публичный каталог и fingerprint.

import type { JsonValue, SettingsConsumer } from '../../../../shared/providerSettingsContracts.ts';
import type {
  NativeSettingsCapability,
  NativeSettingsContext,
  NativeSettingsEvidence,
  NativeSettingsReadback,
  PreparedNativeSettings,
} from './types.ts';
import { nativeSettingsContext } from './context.ts';
import { overlayNativeSettings } from './values.ts';
import { canonicalSettingsJson, settingsFingerprint } from './fingerprint.ts';

export interface SettingsSourceOptions<Config> {
  id: string;
  consumers?: readonly SettingsConsumer[];
  bin(config: Config): string;
  context?: (config: Config, cwd: string, consumer: SettingsConsumer) => Promise<NativeSettingsContext>;
  profile(config: Config, consumer: SettingsConsumer): {
    transport: string;
    mode: string;
    identity: JsonValue;
  };
  discover: (
    config: Config,
    ...args: Parameters<NativeSettingsCapability['discover']>
  ) => ReturnType<NativeSettingsCapability['discover']>;
}

/**
 * Оба пути, карточка и запуск, выбирают одинаковый профиль из серверного config.
 * Payload содержит только проверенные адресные overrides, а не копию приватного base.
 */
export function createNativeSettingsCapability<Config>(
  options: SettingsSourceOptions<Config>,
): NativeSettingsCapability {
  const configurations = new WeakMap<NativeSettingsContext, Config>();

  return {
    ...(options.consumers ? { consumers: options.consumers } : {}),
    /**
     * Профиль строится сервером для того же транспорта, который откроет чат.
     * Приватный config привязан к объекту контекста и не попадает в каталог.
     */
    async context(input, cwd, consumer = 'chat') {
      const config = input as Config;
      const profile = options.profile(config, consumer);
      const common = options.context
        ? await options.context(config, cwd, consumer)
        : await nativeSettingsContext(
          { id: options.id, bin: () => options.bin(config) }, config, cwd, consumer,
        );
      const context = Object.assign(common, {
        transport: profile.transport,
        mode: profile.mode,
        consumer,
        profileFingerprint: settingsFingerprint([profile.identity, common.runtimeIdentity ?? null]),
      });

      configurations.set(context, config);

      return context;
    },
    discover(context, request) {
      if (!configurations.has(context)) {
        return Promise.reject(new Error('Контекст источника настроек не принадлежит адаптеру'));
      }

      return options.discover(configurations.get(context)!, context, request);
    },
    async prepare(context, snapshot, accepted, { signal }) {
      signal.throwIfAborted();

      return {
        providerId: options.id,
        contextFingerprint: settingsFingerprint(context),
        ...(context.runtimeIdentity ? { runtimeIdentity: context.runtimeIdentity } : {}),
        schemaRevision: snapshot.generation,
        storageRevision: '',
        fingerprint: '',
        accepted,
        payload: overlayNativeSettings({}, accepted),
      };
    },
    verify: verifyNativeSettings,
  };
}

/**
 * Effective/read acceptance подтверждают передачу слоя; только applied подтверждает
 * применение конкретной сессией. Несовпадение и явный отказ не маскируются успехом.
 */
export function verifyNativeSettings(
  plan: PreparedNativeSettings,
  readback: readonly NativeSettingsReadback[],
): NativeSettingsEvidence[] {
  return plan.accepted.map((entry) => {
    const result = readback.find((item) => item.fieldId === entry.fieldId);
    const equal =
      result &&
      Object.hasOwn(result, 'value') &&
      canonicalSettingsJson(result.value) === canonicalSettingsJson(entry.value);

    return {
      fieldId: entry.fieldId,
      fingerprint: plan.fingerprint,
      result: result?.rejected
        ? 'rejected'
        : !result || result.basis === 'unavailable' || !Object.hasOwn(result, 'value')
          ? 'unknown'
          : !equal
            ? 'overridden'
            : result.basis === 'applied'
              ? 'confirmed'
              : 'sent',
      reason: result?.rejected
        ? 'CLI отклонил значение'
        : !result || result.basis === 'unavailable' || !Object.hasOwn(result, 'value')
          ? 'Подтверждение CLI недоступно'
          : !equal
            ? 'CLI использует другое значение'
            : result.basis === 'applied'
              ? 'Применение подтверждено CLI'
              : 'Слой принят CLI',
    };
  });
}
