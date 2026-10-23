import { isInstallPluginId } from '../../../../shared/plugins/pluginInstallValues.ts';

import { recordOrNull } from '../../../../shared/lib/objects.ts';

export type ToolWindowState = Record<string, unknown>;
export interface ToolPanelHandle {
  focus?(): void;
  exportState?(): ToolWindowState | Promise<ToolWindowState>;
  importState?(state: ToolWindowState): void | Promise<void>;
}

const fields: Record<string, string[]> = {
  code: ['project', 'repo', 'root', 'tab', 'gitPane', 'file', 'gitRef', 'line', 'commitSel',
    'branchMode', 'commitsWithWork', 'commitMessage', 'amendCommit', 'commitComposerOpen',
    'commitComposerTouched'],
  ssh: ['sessionId', 'remotePath'],
  db: ['sessionId', 'profileId', 'query'],
  shelf: ['query', 'filter'],
  docker: ['tab', 'viewer'],
};

/**
 * Снимок содержит только явные поля выбора панели и черновики.
 * Адрес iframe, пароли и объекты соединений никогда не передаются между документами.
 */
export function parseToolWindowState(id: string, value: unknown): ToolWindowState | null {
  const state = recordOrNull(value);
  const allowed = fields[id] ?? ['id'];

  if (!state || Object.keys(state).some((key) => !allowed.includes(key))) {
    return null;
  }

  for (const [key, field] of Object.entries(state)) {
    if (key === 'viewer') {
      const viewer = recordOrNull(field);

      if (!viewer || Object.keys(viewer).some((name) => !['kind', 'containerId'].includes(name))
        || !['', 'logs', 'exec'].includes(String(viewer.kind)) || typeof viewer.containerId !== 'string') {
        return null;
      }
    } else if (key === 'commitSel') {
      if (!Array.isArray(field) || field.length > 10000
        || field.some((item) => typeof item !== 'string' || item.length > 512)) {
        return null;
      }
    } else if (key === 'line') {
      if (!Number.isSafeInteger(field) || Number(field) < 0) {
        return null;
      }
    } else if (['branchMode', 'commitsWithWork', 'amendCommit', 'commitComposerOpen',
      'commitComposerTouched'].includes(key)) {
      if (typeof field !== 'boolean') {
        return null;
      }
    } else if (typeof field !== 'string' || field.length > 1048576) {
      return null;
    }
  }

  if (!fields[id] && (!isInstallPluginId(id) || state.id !== id)) {
    return null;
  }

  try {
    const json = JSON.stringify(state);

    return json.length <= 1048576 ? JSON.parse(json) as ToolWindowState : null;
  } catch {
    return null;
  }
}

export interface ToolPanelPorts {
  exportState(id: string): Promise<ToolWindowState>;
  unmount(id: string): Promise<void>;
  mount(id: string, state: ToolWindowState): Promise<void>;
}

const panelPorts = Symbol.for('grigdesk.toolPanelPorts');

type PanelDocument = { [panelPorts]?: ToolPanelPorts };

/**
 * Назначает порты единственного render-site текущему dock документа.
 * Ни снимок панели, ни обработчики не сохраняются на диск.
 */
export function setToolPanelPorts(document: object, ports: ToolPanelPorts | undefined) {
  (document as PanelDocument)[panelPorts] = ports;
}

/**
 * Возвращает текущие порты владельца без создания или монтирования панели.
 * До появления ToolHost координатор получает явное отсутствие порта.
 */
export function getToolPanelPorts(document: object) {
  return (document as PanelDocument)[panelPorts];
}

/**
 * Преобразует registry id страницы плагина в закрытый native id.
 * Встроенные инструменты используют одно имя в обоих документах.
 */
export function nativeToolId(id: string): string {
  return ['code', 'shelf', 'ssh', 'db', 'docker'].includes(id) ? id : 'plugin:' + id;
}

/**
 * Обратное преобразование native id остаётся в одном адаптере.
 * Registry сам выбирает компонент и адрес iframe по установленному плагину.
 */
export function registryToolId(id: string): string {
  return id.startsWith('plugin:') ? id.slice(7) : id;
}
