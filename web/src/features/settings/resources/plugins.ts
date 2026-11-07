import { localeMessage, localeTranslator, type LocaleSource } from '../../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../../shared/i18n/catalogs.ts';
import type { PluginListItem, PluginSetting } from '../../../../../shared/plugins/pluginsContracts.ts';
import { decodeSettingsJson } from '../../../../../shared/chat/providerSettingsContracts.ts';
import type { FieldIntent, JsonValue, ResourceAdapter, WriteOutcome } from '../contracts.ts';

export interface PluginStorePort {
  list: PluginListItem[];
  loaded: boolean;
  load(): Promise<unknown>;
  saveSettings(id: string, values: Record<string, JsonValue>, placements: Record<string, boolean>):
    Promise<WriteOutcome & { values?: Record<string, JsonValue>; placements?: PluginListItem['placements'] }>;
  toggle(id: string, enabled: boolean): Promise<WriteOutcome & { enabled?: boolean }>;
}

/**
 * Адрес внутреннего ключа различает values и slots, даже если имена содержат точки.
 * Исходный непрозрачный ключ не разбирается на вложенный объект.
 */
export function pluginValueKey(section: 'values' | 'placements', key: string): string {
  return JSON.stringify([section, key]);
}

/**
 * Полная проекция ограничена объявленными полями; лишние prefs не отправляются обратно.
 * Умолчания используются только как фактический baseline, полученный из манифеста.
 */
export function pluginValues(plugin: PluginListItem): Record<string, JsonValue> {
  return Object.fromEntries([
    ...plugin.settings.map((field) => [
      pluginValueKey('values', field.key),
      decodeSettingsJson(Object.hasOwn(plugin.values, field.key)
        ? plugin.values[field.key] : field.default ?? null),
    ]),
    ...(plugin.placements ?? []).map((field) => [pluginValueKey('placements', field.slot), field.enabled]),
  ]);
}

/**
 * Проверка формы не приводит пустое число к нулю и сохраняет типы массивов и modelRef.
 * Пропавшая модель остаётся допустимой сохранённой парой, а выбор меняет её явно.
 */
export function validPluginValue(field: PluginSetting, value: JsonValue): boolean {
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
  }
  if (field.type === 'checkbox') {
    return typeof value === 'boolean';
  }
  if (field.type === 'providers') {
    return Array.isArray(value) && value.every((id) => typeof id === 'string');
  }
  if (field.type === 'model') {
    return value === null || typeof value === 'object' && !Array.isArray(value)
      && typeof value.provider === 'string' && Boolean(value.provider)
      && typeof value.model === 'string' && Boolean(value.model)
      && (value.effort === undefined || typeof value.effort === 'string' && Boolean(value.effort));
  }
  if (field.type === 'select') {
    return typeof value === 'string' && Boolean(field.options?.includes(value));
  }

  return typeof value === 'string';
}

/**
 * Схема и baseline определяют полный PUT, намерения заменяют только изменённые значения.
 * Settings предшествует enabled в общей цепочке конкретного плагина.
 */
export function createPluginSettingsAdapter(id: string, store: PluginStorePort,
  locale: LocaleSource = 'ru',
): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  const plugin = () => store.list.find((entry) => entry.id === id);

  return {
    id: `pluginSettings:${id}`,
    chain: `plugin:${id}`,
    order: 200,
    sortKey: [id, '0-settings'],
    body: 'full-record',
    supportsUnset: false,
    /**
     * Общий каталог достаточно загрузить один раз до снимка конкретного плагина.
     * Исчезновение элемента даёт видимую ошибку вместо ложного пустого baseline.
     */
    async read(_signal, refresh = false) {
      if (refresh || !store.loaded) {
        await store.load();
      }

      const entry = plugin();

      if (!entry) {
        throw new Error(t("settings.pluginNoLongerAvailable"));
      }

      return pluginValues(entry);
    },
    validate(intents) {
      const entry = plugin();

      return [...intents].flatMap(([key, intent]) => {
        const field = entry?.settings.find((item) => pluginValueKey('values', item.key) === key);
        const slot = entry?.placements?.find((item) => pluginValueKey('placements', item.slot) === key);
        const valid = intent.op === 'set' && (field ? validPluginValue(field, intent.value)
          : slot && typeof intent.value === 'boolean');

        return valid ? [] : [{ key, message: messageText("settings.fieldUnavailableOrValueDoesNotMatch") }];
      });
    },
    /**
     * Сервер заменяет весь record; передаются и неизменённые ключи своей схемы.
     * ACK содержит только реально возвращённые значения и размещения.
     */
    async write(intents, baseline) {
      const entry = plugin();

      if (!entry) {
        return {
          status: 'failed',
          fields: [],
          message: messageText("settings.pluginNoLongerAvailable"),
        };
      }

      const full = { ...baseline };

      for (const [key, intent] of intents) {
        if (intent.op === 'set') {
          full[key] = intent.value;
        }
      }

      const values = Object.fromEntries(entry.settings.map((field) => [field.key,
        Object.hasOwn(full, pluginValueKey('values', field.key)) ? full[pluginValueKey('values', field.key)]!
          : decodeSettingsJson(entry.values[field.key] ?? field.default ?? null),
      ]));
      const placements = Object.fromEntries((entry.placements ?? []).map((field) => [field.slot,
        full[pluginValueKey('placements', field.slot)] === true,
      ]));
      const result = await store.saveSettings(id, values, placements);

      if (!result.ok) {
        return {
          status: result.outcome,
          fields: [],
          message: result.message,
          httpStatus: result.status,
        };
      }

      return {
        status: 'success',
        fields: [...intents].map(([key]) => {
          const field = entry.settings.find((item) => pluginValueKey('values', item.key) === key);
          const slot = entry.placements?.find((item) => pluginValueKey('placements', item.slot) === key);
          const accepted = slot && result.placements?.find((item) => item.slot === slot.slot);

          return {
            key,
            status: 'success',
            ...(field && result.values && Object.hasOwn(result.values, field.key)
              ? { serverValue: result.values[field.key] }
              : accepted ? { serverValue: accepted.enabled } : {}),
          };
        }),
      };
    },
  };
}

/**
 * Тумблер сохраняет отдельное явное намерение после настроек своего плагина.
 * ACK несёт фактически принятое enabled, а отсутствующий плагин остаётся failed.
 */
export function createPluginEnabledAdapter(id: string, store: PluginStorePort,
  locale: LocaleSource = 'ru',
): ResourceAdapter {
  const t = localeTranslator(locale);
  const messageText = localeMessage(locale);

  return {
    id: `pluginEnabled:${id}`,
    chain: `plugin:${id}`,
    order: 200,
    sortKey: [id, '1-enabled'],
    body: 'patch',
    supportsUnset: false,
    async read(_signal, refresh = false) {
      if (refresh || !store.loaded) {
        await store.load();
      }

      return { enabled: store.list.find((entry) => entry.id === id)?.enabled ?? false };
    },
    validate: (intents) => [...intents].flatMap(([key, intent]) =>
      store.list.some((entry) => entry.id === id) && intent.op === 'set' && typeof intent.value === 'boolean'
        ? [] : [{ key, message: messageText("settings.pluginUnavailableOrStatusUnspecified") }]),
    /**
     * Переключение следует после успешного PUT того же плагина.
     * Отсутствующий ACK не очищает намерение и не закрывает форму.
     */
    async write(intents) {
      const intent = intents.get('enabled');

      if (intent?.op !== 'set' || typeof intent.value !== 'boolean') {
        return {
          status: 'failed',
          fields: [],
          message: messageText("settings.pluginStatusUnspecified"),
        };
      }

      const result = await store.toggle(id, intent.value);

      return result.ok ? {
        status: 'success',
        fields: [{
          key: 'enabled',
          status: 'success',
          serverValue: result.enabled,
        }],
      } : {
        status: result.outcome,
        fields: [],
        message: result.message,
        httpStatus: result.status,
      };
    },
  };
}
