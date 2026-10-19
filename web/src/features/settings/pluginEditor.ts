import { effectScope, watch } from 'vue';
import type { useSettingsStore } from '../../stores/settings.ts';
import type { SessionField } from './contracts.ts';
import {
  createPluginSettingsAdapter,
  createPluginEnabledAdapter,
  pluginValues,
  pluginValueKey,
  type PluginStorePort,
} from './resources/plugins.ts';

/**
 * Ресурс плагина остаётся в общей сессии при выборе другого элемента каталога.
 * Смена схемы не переинтерпретирует dirty старого типа и не теряет удалённое поле.
 */
export function createPluginEditor(
  id: string,
  settings: ReturnType<typeof useSettingsStore>,
  plugins: PluginStorePort,
) {
  const scope = effectScope(true);
  const opening = settings.snapshot.sessionId;
  const resourceId = `pluginSettings:${id}`;
  const enabledId = `pluginEnabled:${id}`;
  const adapter = createPluginSettingsAdapter(id, plugins);
  const enabledAdapter = createPluginEnabledAdapter(id, plugins);
  const schemas = new Map<string, string>();

  /**
   * Register удерживает отсутствующие dirty-поля, а metadata оставляет их подписи.
   * Значения и секреты не добавляются в поисковый индекс ни при одном обновлении.
   */
  function sync(): void {
    if (!settings.isOpen || settings.snapshot.sessionId !== opening) {
      return;
    }

    const plugin = plugins.list.find((entry) => entry.id === id);
    const state = settings.snapshot.resources.find((resource) => resource.id === resourceId);
    const fields: SessionField[] = (plugin?.settings ?? []).map((field) => {
      const key = pluginValueKey('values', field.key);
      const signature = JSON.stringify([
        field.type, field.min, field.max, field.step, field.options, field.requiresCapability,
      ]);
      const dirty = state?.fields.find((item) => item.key === key)?.dirty;
      const changed = dirty && schemas.has(key) && schemas.get(key) !== signature;

      if (!changed) {
        schemas.set(key, signature);
      }

      return {
        key,
        secret: ['secret', 'password'].includes(field.type ?? ''),
        address: {
          pageId: 'plugins.installed',
          entityId: id,
          fieldPath: ['values', field.key],
        },
        ...changed ? {
          unavailable: 'Схема поля изменилась. Отмените правку и выберите значение заново.',
        } : {},
      };
    });

    fields.push(...(plugin?.placements ?? []).map((field) => ({
      key: pluginValueKey('placements', field.slot),
      address: {
        pageId: 'plugins.installed',
        entityId: id,
        fieldPath: ['placements', field.slot],
      },
    })));
    settings.registerResource(adapter, fields);
    settings.registerResource(enabledAdapter, plugin ? [{
      key: 'enabled',
      address: {
        pageId: 'plugins.installed',
        entityId: id,
        fieldPath: ['enabled'],
      },
    }] : []);

    if (plugin && state?.loaded) {
      settings.acceptSnapshot(resourceId, pluginValues(plugin), opening);
    }
    if (plugin && settings.snapshot.resources.some((resource) =>
      resource.id === enabledId && resource.loaded)) {
      settings.acceptSnapshot(enabledId, { enabled: plugin.enabled }, opening);
    }

    settings.setDynamicFields(`plugin:${id}`, plugin ? [
      ...fields.map((field) => {
        const schema = plugin.settings.find((item) => pluginValueKey('values', item.key) === field.key);
        const slot = plugin.placements?.find((item) => pluginValueKey('placements', item.slot) === field.key);

        return {
          address: field.address,
          label: schema?.label || slot?.label || schema?.key || '',
          description: schema?.hint || '',
          available: !field.unavailable,
        };
      }),
      {
        address: {
          pageId: 'plugins.installed',
          entityId: id,
          fieldPath: ['enabled'],
        },
        label: `Включить ${plugin.name}`,
        description: 'Доступность плагина для всех устройств',
      },
    ] : []);
  }

  /**
   * Посещение читает baseline один раз, но перед ним синхронизирует текущую схему.
   * Порядок HTTP определяет координатор Apply, а не порядок открытия формы.
   */
  async function load(): Promise<void> {
    sync();
    await settings.loadResource(resourceId);
    await settings.loadResource(enabledId);
  }

  sync();
  scope.run(() => watch(() => plugins.list, sync, { deep: true, flush: 'sync' }));
  settings.bindSession(`plugin-editor:${id}`, () => () => scope.stop());

  return { load, sync };
}
