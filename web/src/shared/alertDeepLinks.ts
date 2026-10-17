import { watch } from 'vue';
import { ALERT_CHAT_QUERY, ALERT_TASK_QUERY, firstQueryValue } from './alertTargets.ts';
import type { AlertTarget } from './alertTargets.ts';

export interface AlertLinkDeps {
  route: {
    path: string;
    query: Record<string, unknown>;
  };
  router: {
    push(location: {
      path: string;
      query?: Record<string, string>;
    }): unknown;
    replace(location: {
      path: string;
      query: Record<string, unknown>;
    }): unknown;
  };
  chat: {
    revealChat(chatId: string): Promise<boolean> | boolean;
  };
  ui: {
    openTask(taskId: string): void;
  };
}

/**
 * Кнопка тоста ведёт в чат или конвейер, а задачу открывает поверх текущего раздела.
 * Чат использует тот же query-контракт, что и щелчок по системному уведомлению.
 */
export function openAlertTarget(target: AlertTarget, deps: AlertLinkDeps): void {
  if (target.kind === 'studio') {
    void deps.router.push({
      path: '/3d',
      query: { model: target.modelId, version: target.versionId }
    });
  } else if (target.kind === 'task') {
    deps.ui.openTask(target.taskId);
  } else if (target.kind === 'chat') {
    void deps.router.push({
      path: '/chats',
      query: {
        [ALERT_CHAT_QUERY]: target.chatId
      }
    });
  } else {
    void deps.router.push({
      path: '/pipeline'
    });
  }
}

/**
 * Поглощает командные query-параметры до открытия целевой поверхности.
 * Очистка адреса не позволяет повторить действие после следующей смены маршрута.
 */
export function installAlertDeepLinks(deps: AlertLinkDeps): () => void {
  return watch(() => [
    firstQueryValue(deps.route.query[ALERT_CHAT_QUERY]),
    firstQueryValue(deps.route.query[ALERT_TASK_QUERY]),
  ], ([chatId, taskId]) => {
    if (!chatId && !taskId) {
      return;
    }

    const query = {
      ...deps.route.query
    };

    delete query[ALERT_CHAT_QUERY];
    delete query[ALERT_TASK_QUERY];
    void deps.router.replace({
      path: deps.route.path,
      query
    });

    if (chatId) {
      void Promise.resolve(deps.chat.revealChat(chatId)).catch(() => { });
    }
    if (taskId) {
      deps.ui.openTask(taskId);
    }
  }, {
    immediate: true
  });
}
