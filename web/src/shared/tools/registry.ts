// Только встроенные инструменты могут монтировать Vue-панель. Серверный manifest
// выбирает место ссылки (`nav.group`), но не исполняет произвольный frontend-код.
// Состав и подписи живут в catalog.js; здесь к каждому инструменту добавляется его
// панель, поэтому импорт этого модуля означает готовность грузить Monaco и терминал.
//
// Страница пользовательского плагина — тоже инструмент, но без своего Vue: ядро
// показывает её одной общей панелью-iframe, а сам плагин рисует, что хочет, и ходит
// в API сам. Такие инструменты собираются из стора плагинов на лету (`toolsOf`).
import { uiLocale } from '../../ui.ts';
import { translator } from '../../../../shared/i18n/catalogs.ts';
import { asyncView } from '../asyncView.ts';
import type { Component } from 'vue';
import CodePanelLoading from '../../views/code/codePanelLoading.ts';
import { TOOL_CATALOG, pluginPageRoute } from './catalog.ts';
import type { ToolMeta } from './catalog.ts';

export interface ToolEntry extends ToolMeta {
  // Встроенный инструмент без панели (терминал ведёт своя страница) остаётся в реестре
  // ради рейки и горячих клавиш — компонент у него не обязателен.
  component: Component | undefined;
  // Пропсы панели сверх общих (active/compact/presentation/intents): у панели-iframe
  // это адрес страницы плагина.
  panelProps?: Record<string, unknown>;
}

// Страница плагина в объёме, который читает реестр: то, что отдаёт стор плагинов.
export interface PluginWebPage {
  id: string;
  src: string;
  label: string;
  icon: string;
  order: number;
}

interface PluginsPagesPort {
  webPages: PluginWebPage[];
}

// Панель на инструмент. Ключи совпадают с `id` каталога — это и есть условие
// «только встроенный инструмент монтирует Vue».
const PANELS: Record<string, Component> = {
  code: asyncView(() => import('../../views/code/CodePanel.vue'), CodePanelLoading),
  shelf: asyncView(() => import('../../views/shelf/TaskShelfPanel.vue')),
  studio3d: asyncView(() => import('../../views/studio3d/Studio3dPanel.vue')),
  terminal: asyncView(() => import('../../views/terminal/TerminalPanel.vue')),
  ssh: asyncView(() => import('../../views/ssh/SshPanel.vue')),
  db: asyncView(() => import('../../views/db/DbPanel.vue')),
  docker: asyncView(() => import('../../views/docker/DockerPanel.vue')),
};

const PluginFramePanel = asyncView(() => import('../../views/ext/PluginFramePanel.vue'));

export const TOOL_REGISTRY: ToolEntry[] = TOOL_CATALOG.map((item) => ({
  ...item,
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
  return plugins.webPages.map((page) => ({
    id: page.id,
    route: pluginPageRoute(page.id),
    label: page.label,
    icon: page.icon,
    order: page.order,
    hotkey: '',
    plugin: page.id,
    component: PluginFramePanel,
    panelProps: { src: page.src, label: page.label },
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
