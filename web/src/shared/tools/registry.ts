// Только встроенные инструменты могут монтировать Vue-панель. Серверный manifest
// выбирает место ссылки (`nav.group`), но не исполняет произвольный frontend-код.
// Состав и подписи живут в catalog.js; здесь к каждому инструменту добавляется его
// панель, поэтому импорт этого модуля означает готовность грузить Monaco и терминал.
import { defineAsyncComponent } from 'vue';
import CodePanelLoading from '../../views/code/codePanelLoading.ts';
import { TOOL_CATALOG } from './catalog.ts';

// Панель на инструмент. Ключи совпадают с `id` каталога — это и есть условие
// «только встроенный инструмент монтирует Vue».
const PANELS: Record<string, ReturnType<typeof defineAsyncComponent>> = {
  code: defineAsyncComponent({
    loader: () => import('../../views/code/CodePanel.vue'),
    loadingComponent: CodePanelLoading,
    delay: 0,
    suspensible: false,
  }),
  shelf: defineAsyncComponent(() => import('../../views/shelf/TaskShelfPanel.vue')),
  terminal: defineAsyncComponent(() => import('../../views/terminal/TerminalPanel.vue')),
  ssh: defineAsyncComponent(() => import('../../views/ssh/SshPanel.vue')),
  db: defineAsyncComponent(() => import('../../views/db/DbPanel.vue')),
  docker: defineAsyncComponent(() => import('../../views/docker/DockerPanel.vue')),
};

export const TOOL_REGISTRY = TOOL_CATALOG.map((item) => ({ ...item, component: PANELS[item.id] }));

export const TOOL_BY_ID = new Map(TOOL_REGISTRY.map((item) => [item.id, item]));
export const TOOL_BY_ROUTE = new Map(TOOL_REGISTRY.map((item) => [item.route, item]));

export { toolAvailability } from './catalog.ts';
