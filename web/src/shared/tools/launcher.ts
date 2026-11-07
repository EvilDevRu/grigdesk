import { getActivePinia } from 'pinia';

import { useRoute, useRouter } from 'vue-router';
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router';

import { getToolWindowCoordinator } from '../../stores/toolWindows.ts';
import type { ToolWindowCoordinator } from '../../stores/toolWindows.ts';
import { usePluginsStore } from '../../stores/plugins.ts';
import { pluginPageRoute } from './catalog.ts';

import { useDockStore } from '../../stores/dock.ts';
import { TOOL_META_BY_ID } from './catalog.ts';
import { viewportCanDock } from './viewport.ts';

// Команда, которую инструмент должен выполнить сразу после открытия. Тип задаёт сам
// инструмент, поэтому здесь она остаётся свободной формой с обязательным `type`:
// панель разбирает её сама, а launcher только доставляет.
export interface ToolIntent {
  type: string;
  [field: string]: unknown;
}

// Локальный порт ограничен действиями, которые нужны запуску инструмента:
// очередь намерений, открытие и runtime-флаги панели.
interface DockPort {
  runtime: Record<string, { focusNonce?: unknown } | undefined>;
  enqueue: (id: string, payload: ToolIntent) => void;
  open: (id: string) => void;
  setRuntime: (id: string, value: Record<string, unknown>) => void;
}

export interface LaunchContext {
  route: RouteLocationNormalizedLoaded;
  router: Router;
  dock: DockPort;
  canDock?: () => boolean;
  toolWindows?: ToolWindowCoordinator;
}

/**
 * Единый вход во встроенные инструменты. Intent кладётся ДО навигации/монтирования,
 * поэтому команда не теряется ни на lazy import, ни на закрытом WebSocket.
 */
export async function launchTool(
  { route, router, dock, toolWindows, canDock = viewportCanDock }: LaunchContext,
  id: string,
  intent: ToolIntent | null = null,
): Promise<boolean> {
  const coordinator = toolWindows ?? getToolWindowCoordinator(dock as ReturnType<typeof useDockStore>);

  if (await coordinator?.activateIfDetached(id, intent)) {
    return true;
  }

  const item = TOOL_META_BY_ID.get(id)
    ?? (getActivePinia() && usePluginsStore().modulePages
      .some((page) => page.id === id)
      ? { route: pluginPageRoute(id) } : null);

  if (!item) {
    return false;
  }
  if (intent) {
    dock.enqueue(id, intent);
  }

  const focus = () => {
    const nonce = Number(dock.runtime[id]?.focusNonce || 0) + 1;

    dock.setRuntime(id, { focusNonce: nonce });
  };
  const routeTool = route.meta?.tool === 'ext' ? route.params.id : route.meta?.tool || null;

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

// Точная цель открытия файла: без репозитория и пути это просто выбор проекта.
export interface OpenCodeTarget {
  project?: string;
  repo?: string;
  root?: string;
  path?: string;
  line?: number;
}

export interface ToolLauncher {
  openTool: (id: string, intent?: ToolIntent | null) => Promise<boolean>;
  openCode: (target?: OpenCodeTarget) => Promise<boolean>;
  openTerminal: (target?: { insert?: string }) => Promise<boolean>;
}

/**
 * Запуск инструментов из компонента: маршрут, роутер и док берутся из его контекста.
 * Отдельная обёртка нужна, чтобы вызывающий не собирал контекст сам — иначе каждый
 * раздел выбирал бы себе свой док.
 */
export function useToolLauncher(): ToolLauncher {
  const route = useRoute();
  const router = useRouter();
  const dock: DockPort = useDockStore();

  const context: LaunchContext = {
    route,
    router,
    dock,
  };
  const openTool = (id: string, intent: ToolIntent | null = null) => launchTool(
    context,
    id,
    intent,
  );

  return {
    openTool,
    // Точная цель (репозиторий + путь) сильнее выбора одного проекта: она сама
    // переключит панель на нужную рабочую копию и откроет файл.
    openCode: ({ project, repo, root, path, line = 0 }: OpenCodeTarget = {}) => openTool(
      'code',
      repo && root && path
        ? {
          type: 'open-file',
          project,
          repo,
          root,
          path,
          line,
        }
        : (project ? { type: 'project', project } : null),
    ),
    openTerminal: ({ insert }: { insert?: string } = {}) => openTool(
      'terminal',
      insert ? { type: 'insert', text: String(insert) } : null,
    ),
  };
}
