import type { MobileApp } from '../mobileServer.ts';
import { decodeContract } from '../contract.ts';
import { record, upstream } from './common.ts';
import type { FacadeDeps } from './common.ts';

/**
 * Навигация считает все шапки и сводку задач, независимо от открытой страницы приложения.
 * Одна задача учитывается один раз: остановка важнее ворот; вопросы считаются по чатам.
 */
export function registerAttentionRoutes(app: MobileApp, deps: FacadeDeps) {
  app.get('/api/mobile/v1/attention', async () => {
    const [heads, waiting, active, source] = await Promise.all([
      deps.chat.heads(),
      upstream(deps, 'GET', '/api/chat/waiting'),
      upstream(deps, 'GET', '/api/chat/active'),
      upstream(deps, 'GET', '/api/tasks'),
    ]);
    const questions = Array.isArray(waiting.waiting) ? waiting.waiting.map(record) : [];
    const runs = Array.isArray(active.active) ? active.active.map(record) : [];
    const tasks = {
      waiting: 0,
      stalled: 0,
      running: 0,
    };

    for (const task of Array.isArray(source.tasks) ? source.tasks.map(record) : []) {
      if (['done', 'completed'].includes(String(task.result))) {
        continue;
      }
      if (task.stall || task.readOnly) {
        tasks.stalled += 1;
      } else if (task.stalledHuman || task.bootstrapStop || Object.values(record(task.stages))
        .some((state) => ['wait', 'waiting', 'premature'].includes(String(state)))) {
        tasks.waiting += 1;
      } else if (task.daemonAlive) {
        tasks.running += 1;
      }
    }

    return decodeContract('attention', {
      chats: {
        waiting: new Set(questions.map((item) => item.chatKey).filter(Boolean)).size,
        unread: heads.filter((chat) => chat.unread === true).length,
        running: new Set(runs.map((item) => item.chatKey).filter(Boolean)).size,
      },
      tasks,
    });
  });
}
