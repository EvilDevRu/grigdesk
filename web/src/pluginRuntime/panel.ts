import { launchTool } from '../shared/tools/launcher.ts';
import type { LaunchContext } from '../shared/tools/launcher.ts';
import { viewportCanDock } from '../shared/tools/viewport.ts';

export interface PluginPanelOptions {
  router: LaunchContext['router'];
  dock: LaunchContext['dock'] & {
    isOpen: boolean;
    activeTool: string | null;
    close(): void;
    setExpanded(value: boolean): void;
  };
  isAlive: () => boolean;
  canDock?: () => boolean;
}

/**
 * Команды не принимают чужой id и читают актуальный маршрут в момент вызова.
 * Tool-страница владеет экраном: лежащий под ней док не закрывается и не разворачивается.
 */
export function createPluginPanel(pluginId: string, options: PluginPanelOptions) {
  const { router, dock, isAlive, canDock = viewportCanDock } = options;
  const ownsDock = () => isAlive() && canDock() && !router.currentRoute.value.meta?.tool
    && dock.isOpen && dock.activeTool === pluginId;

  return {
    open: async (): Promise<boolean> => {
      if (!isAlive()) {
        return false;
      }

      return launchTool({
        route: router.currentRoute.value,
        router,
        dock,
        canDock,
      }, pluginId);
    },
    close: async (): Promise<boolean> => {
      if (!isAlive()) {
        return false;
      }

      const route = router.currentRoute.value;

      if (route.meta?.tool === 'ext' && route.params.id === pluginId) {
        await router.push('/chats');

        return true;
      }
      if (!ownsDock()) {
        return false;
      }

      dock.close();

      return true;
    },
    setExpanded: (value: boolean): boolean => {
      if (!ownsDock()) {
        return false;
      }

      dock.setExpanded(value);

      return true;
    },
  };
}
