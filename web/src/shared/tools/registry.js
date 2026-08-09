// Только встроенные инструменты могут монтировать Vue-панель. Серверный manifest
// выбирает место ссылки (`nav.group`), но не исполняет произвольный frontend-код.
import { defineAsyncComponent } from 'vue';
import CodePanelLoading from '../../views/code/CodePanelLoading.js';

export const TOOL_REGISTRY = [
  {
    id: 'code',
    route: '/code',
    label: 'Код',
    icon: 'code',
    order: 10,
    plugin: 'code',
    component: defineAsyncComponent({
      loader: () => import('../../views/code/CodePanel.vue'),
      loadingComponent: CodePanelLoading,
      delay: 0,
      suspensible: false,
    }),
  },
  {
    id: 'terminal',
    route: '/terminal',
    label: 'Терминал',
    icon: 'terminal',
    order: 20,
    component: defineAsyncComponent(() => import('../../views/terminal/TerminalPanel.vue')),
  },
];

export const TOOL_BY_ID = new Map(TOOL_REGISTRY.map((item) => [item.id, item]));
export const TOOL_BY_ROUTE = new Map(TOOL_REGISTRY.map((item) => [item.route, item]));

export function toolAvailability(item, plugins) {
  if (!item) return 'disabled';
  if (!item.plugin) return 'enabled';
  if (!plugins.loaded) return 'pending';
  return plugins.enabled(item.plugin) ? 'enabled' : 'disabled';
}
