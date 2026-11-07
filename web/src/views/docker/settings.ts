// Адаптер нетипизированного каталога плагинов для настроек панели Docker.

export interface DockerSettings {
  allowExec?: boolean;
  allowVolumeRemoval?: boolean;
  allowImagePruneAll?: boolean;
}

function booleanSetting(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * До миграции общего каталога настройки приходят как unknown. Отсутствующие
 * флаги сохраняют прежние defaults: exec разрешён, опасная уборка выключена.
 */
export function dockerSettings(plugin: unknown): DockerSettings {
  if (typeof plugin !== 'object' || plugin === null || !('values' in plugin)) {
    return {};
  }

  const values = plugin.values;

  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return {};
  }

  return {
    allowExec: booleanSetting('allowExec' in values ? values.allowExec : undefined),
    allowVolumeRemoval: booleanSetting(
      'allowVolumeRemoval' in values ? values.allowVolumeRemoval : undefined,
    ),
    allowImagePruneAll: booleanSetting(
      'allowImagePruneAll' in values ? values.allowImagePruneAll : undefined,
    ),
  };
}
