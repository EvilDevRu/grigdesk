import { validateHotkeyOverrides } from '../../../stores/hotkeys.js';
import type { JsonValue, ResourceAdapter } from '../contracts.ts';

interface DevicePort {
  wakeLockEnabled: boolean;
  setWakeLockEnabled(enabled: boolean): Promise<unknown>;
}

interface HotkeysPort {
  overrides: Record<string, string>;
  replaceOverrides(map: unknown): { ok: boolean; error?: string };
}

/**
 * Успех означает принятую локальную настройку, независимо от захвата системной блокировки.
 * Ошибка захвата остаётся состоянием device store и не превращает Apply в отказ.
 */
export function createWakeLockAdapter(device: DevicePort): ResourceAdapter {
  return {
    id: 'wakeLock',
    chain: 'device',
    order: 9000,
    body: 'patch',
    supportsUnset: false,
    read: async () => ({ enabled: device.wakeLockEnabled }),
    validate: () => [],
    async write(intents) {
      const intent = intents.get('enabled');

      await device.setWakeLockEnabled(intent?.op === 'set' && intent.value === true);

      return {
        status: 'success',
        fields: [{
          key: 'enabled',
          status: 'success',
          serverValue: device.wakeLockEnabled,
        }],
      };
    },
  };
}

/**
 * Черновик держит полную карту overrides, а доменный store получает её один раз.
 * Валидация использует ту же итоговую карту, что и атомарная замена сочетаний.
 */
export function createHotkeysAdapter(hotkeys: HotkeysPort): ResourceAdapter {
  return {
    id: 'hotkeys',
    chain: 'device',
    order: 8000,
    body: 'full-record',
    supportsUnset: false,
    read: async () => ({ overrides: JSON.parse(JSON.stringify(hotkeys.overrides)) as JsonValue }),
    /**
     * Полная карта проверяется до первой записи всех ресурсов.
     * Ошибка привязывается к общему адресу поля сочетаний.
     */
    validate(intents) {
      const intent = intents.get('overrides');
      const result = intent?.op === 'set'
        ? validateHotkeyOverrides(intent.value) : { ok: true, error: undefined };

      return result.ok ? [] : [{ key: 'overrides', message: result.error ?? 'Некорректное сочетание' }];
    },
    /**
     * Доменный store меняет карту одним действием после проверки.
     * В подтверждении возвращается именно принятая нормализованная карта.
     */
    async write(intents) {
      const intent = intents.get('overrides');
      const result = hotkeys.replaceOverrides(intent?.op === 'set' ? intent.value : {});

      return {
        status: result.ok ? 'success' : 'failed',
        fields: [{
          key: 'overrides',
          status: result.ok ? 'success' : 'failed',
          serverValue: JSON.parse(JSON.stringify(hotkeys.overrides)) as JsonValue,
          message: result.error,
        }],
      };
    },
  };
}
