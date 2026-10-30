import { isInstallPluginId } from '../plugins/pluginInstallValues.ts';
import { recordOrNull } from '../lib/objects.ts';

export type ToolWindowAction = 'window-state' | 'minimize' | 'toggle-maximize';

export type ToolWindowControlResult = { accepted: false }
  | { accepted: true; maximized: boolean };

export type ToolControl = { action: 'open'; id: string }
  | { action: 'status' }
  | {
    action: 'focus' | 'close' | ToolWindowAction;
    id: string;
    instance: string;
  };

/**
 * Допускает только встроенные переносимые панели и установочные id плагинов.
 * Терминал и 3D сохраняют прежнего владельца документа.
 */
export function isToolWindowId(value: unknown): value is string {
  return typeof value === 'string' && (['code', 'shelf', 'ssh', 'db', 'docker'].includes(value)
    || (value.startsWith('plugin:') && isInstallPluginId(value.slice(7))));
}

/**
 * Instance ограничена безопасным непрозрачным идентификатором native.
 * Пустые значения не могут адресовать уже созданное окно.
 */
export function isToolInstance(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

/**
 * Native принимает только управление известным окном, без адресов и опций ОС.
 * Instance обязательна для действий над уже созданным документом.
 */
export function parseToolControl(value: unknown): ToolControl | null {
  const item = recordOrNull(value);

  if (!item) {
    return null;
  }

  const count = Object.keys(item).length;

  if (item.action === 'status' && count === 1) {
    return { action: 'status' };
  }

  if (!isToolWindowId(item.id)) {
    return null;
  }

  if (item.action === 'open' && count === 2) {
    return { action: 'open', id: item.id };
  }

  if ((item.action === 'focus' || item.action === 'close' || item.action === 'window-state'
    || item.action === 'minimize' || item.action === 'toggle-maximize') && count === 3
    && isToolInstance(item.instance)) {
    return {
      action: item.action,
      id: item.id,
      instance: item.instance,
    };
  }

  return null;
}
