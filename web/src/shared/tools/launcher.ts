import { useRoute, useRouter } from 'vue-router';
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router';

import { useDockStore } from '../../stores/dock.js';
import { TOOL_META_BY_ID } from './catalog.ts';
import { viewportCanDock } from './viewport.ts';

// Команда, которую инструмент должен выполнить сразу после открытия. Тип задаёт сам
// инструмент, поэтому здесь она остаётся свободной формой с обязательным `type`:
// панель разбирает её сама, а launcher только доставляет.
export interface ToolIntent {
  type: string;
  [field: string]: unknown;
}

// Док ещё на JavaScript, и вывод типов не знает форму его действий. Объявлено ровно
// то, что зовёт этот файл: очередь намерений, открытие и runtime-флаги панели.
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
}

/**
 * Единый вход во встроенные инструменты. Intent кладётся ДО навигации/монтирования,
 * поэтому команда не теряется ни на lazy import, ни на закрытом WebSocket.
 */
export async function launchTool(
  { route, router, dock, canDock = viewportCanDock }: LaunchContext,
  id: string,
  intent: ToolIntent | null = null,
): Promise<boolean> {
  const item = TOOL_META_BY_ID.get(id);

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
  const dock = useDockStore() as unknown as DockPort;

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
