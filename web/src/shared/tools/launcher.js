import { useRoute, useRouter } from 'vue-router';
import { useDockStore } from '../../stores/dock.js';
import { TOOL_BY_ID } from './registry.js';
import { viewportCanDock } from './viewport.js';

/**
 * Единый вход во встроенные инструменты. Intent кладётся ДО навигации/монтирования,
 * поэтому команда не теряется ни на lazy import, ни на закрытом WebSocket.
 */
export async function launchTool({ route, router, dock, canDock = viewportCanDock }, id, intent = null) {
  const item = TOOL_BY_ID.get(id);
  if (!item) return false;
  if (intent) dock.enqueue(id, intent);

  const focus = () => {
    const nonce = Number(dock.runtime[id]?.focusNonce || 0) + 1;
    dock.setRuntime(id, { focusNonce: nonce });
  };
  const routeTool = route.meta?.tool || null;
  if (routeTool) {
    if (routeTool === id) {
      focus();
      return true;
    }
    await router.push(item.route);
    return true;
  }

  if (canDock()) {
    dock.open(id);
    focus();
  } else {
    await router.push(item.route);
  }
  return true;
}

export function useToolLauncher() {
  const route = useRoute();
  const router = useRouter();
  const dock = useDockStore();

  const openTool = (id, intent = null) => launchTool({ route, router, dock }, id, intent);

  return {
    openTool,
    openCode: ({ project } = {}) => openTool('code', project ? { type: 'project', project } : null),
    openTerminal: ({ insert } = {}) => openTool(
      'terminal',
      insert ? { type: 'insert', text: String(insert) } : null,
    ),
  };
}
