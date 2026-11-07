export type PluginPanelParams = Readonly<Record<string, string>>;

/**
 * Параметры описывают только намерение внутри собственной панели.
 * Форма и пределы одинаковы для query, уведомлений и props модуля.
 */
export function decodePluginPanelParams(value: unknown): PluginPanelParams | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value);

  if (entries.length > 16 || entries.some(([key, item]) =>
    !key.length || key.length > 64 || ['__proto__', 'prototype', 'constructor'].includes(key)
    || /[\x00-\x1f\x7f]/u.test(key) || typeof item !== 'string'
    || item.length > 512 || /[\x00-\x1f\x7f]/u.test(item))) {
    return null;
  }

  return Object.freeze(Object.fromEntries(entries));
}
