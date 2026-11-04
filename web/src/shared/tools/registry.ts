// Встроенные панели и доверенные модули плагинов имеют один реестр дока.
// Manifest задаёт навигацию; исполнение модуля изолирует отдельная ленивая панель.
import { uiLocale } from '../../ui.ts';
import { translator } from '../../../../shared/i18n/catalogs.ts';
import { asyncView } from '../asyncView.ts';
import type { Component } from 'vue';
import { panelLoading } from './panelLoading.ts';
import { TOOL_CATALOG, pluginPageRoute } from './catalog.ts';
import type { ToolMeta } from './catalog.ts';
import type { PluginWebModule } from '../../../../shared/plugins/pluginsContracts.ts';

export interface ToolEntry extends ToolMeta {
  // Встроенный инструмент без панели (терминал ведёт своя страница) остаётся в реестре
  // ради рейки и горячих клавиш — компонент у него не обязателен.
  component: Component | undefined;
  // Пропсы модуля сверх общих active/compact/presentation/intents.
  panelProps?: Record<string, unknown>;
  detachable?: boolean;
}

// Страница плагина в объёме, который читает реестр: то, что отдаёт стор плагинов.
export interface PluginModulePage {
  id: string;
  label: string;
  icon: string;
  order: number;
}

interface PluginsPagesPort {
  modulePages?: Array<PluginModulePage & { descriptor: PluginWebModule }>;
}

// Панель на инструмент. Ключи совпадают с `id` каталога — это и есть условие
// «только встроенный инструмент монтирует Vue».
const PANELS: Record<string, Component> = {
  code: asyncView(() => import('../../views/code/CodePanel.vue'), panelLoading('code')),
  shelf: asyncView(() => import('../../views/shelf/TaskShelfPanel.vue'), panelLoading('shelf')),
  studio3d: asyncView(() => import('../../views/studio3d/Studio3dPanel.vue'), panelLoading('studio3d')),
  terminal: asyncView(() => import('../../views/terminal/TerminalPanel.vue'), panelLoading('terminal')),
  ssh: asyncView(() => import('../../views/ssh/SshPanel.vue'), panelLoading('ssh')),
  db: asyncView(() => import('../../views/db/DbPanel.vue'), panelLoading('db')),
  docker: asyncView(() => import('../../views/docker/DockerPanel.vue'), panelLoading('docker')),
};

const PluginModulePanel = asyncView(
  () => import('../../views/ext/PluginModulePanel.vue'), panelLoading('external'),
);

export const TOOL_REGISTRY: ToolEntry[] = TOOL_CATALOG.map((item) => ({
  ...item,
  icon: item.plugin ? `/plugin-icons/${item.plugin}.png` : item.icon,
  get label() {
    return translator.t(uiLocale.value, `core.builtinNavigation.${item.id}`, {}, item.label);
  },
  component: PANELS[item.id],
}));

export const TOOL_BY_ID = new Map(TOOL_REGISTRY.map((item) => [item.id, item]));
export const TOOL_BY_ROUTE = new Map(TOOL_REGISTRY.map((item) => [item.route, item]));

/**
 * Инструменты из страниц пользовательских плагинов. Владелец панели — сам плагин
 * (`plugin: id`), поэтому выключенный плагин гасит её тем же правилом, что и
 * встроенные. Горячей клавиши нет: сочетания раздаёт каталог встроенных.
 */
export function pluginTools(plugins: PluginsPagesPort): ToolEntry[] {
  const modules = plugins.modulePages ?? [];

  return modules.map((page) => ({
    id: page.id,
    route: pluginPageRoute(page.id),
    label: page.label,
    icon: page.icon,
    order: page.order,
    hotkey: '',
    plugin: page.id,
    component: PluginModulePanel,
    panelProps: {
      pluginId: page.id,
      descriptor: page.descriptor,
      label: page.label,
    },
    detachable: false,
  }));
}

/**
 * Все инструменты сейчас: встроенные и страницы включённых плагинов. Считается на
 * каждый вызов — состав меняется тумблером плагина без перезагрузки страницы.
 */
export function toolsOf(plugins: PluginsPagesPort): ToolEntry[] {
  return [...TOOL_REGISTRY, ...pluginTools(plugins)];
}

/**
 * Инструмент по id: сначала встроенные (их карта статична), затем страницы плагинов.
 * Пустой id — не инструмент: так спрашивает док, когда активной панели нет.
 */
export function toolById(plugins: PluginsPagesPort, id: string | null | undefined): ToolEntry | null {
  if (!id) {
    return null;
  }

  return TOOL_BY_ID.get(id) ?? pluginTools(plugins).find((item) => item.id === id) ?? null;
}

export { toolAvailability } from './catalog.ts';
