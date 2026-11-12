import { isTaskSourceId, parseTaskReference } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import { defineStore } from 'pinia';

import { parseSurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';
import { currentDesktopMode } from '../shared/desktopSettings.ts';
import { resolveSurfaceOpening } from '../shared/surfaceLauncher.ts';
import { shellAction } from '../shared/shellClient.ts';
import { showToast } from '../ui';
import { useShellStore } from './shell.ts';

const generations = new WeakMap<object, number>();

/**
 * Новый выбор или закрытие отменяет применение прежнего асинхронного ответа.
 * Поколение хранится вне сериализуемого состояния интерфейса.
 */
function nextGeneration(store: object): number {
  const value = (generations.get(store) ?? 0) + 1;

  generations.set(store, value);

  return value;
}

/**
 * Труба не повторяет мутации: неизвестный исход требует явного действия человека.
 * Общая блокировка origin оставляет соединения для загрузки нового окна при быстрых кликах.
 * Срок POST начинается после получения блокировки и превышает срок создания окна.
 */
function sendSurface(path: string, body: unknown) {
  const send = () => shellAction('POST', path, body, AbortSignal.timeout(20000));
  const locks = globalThis.navigator?.locks;

  return locks ? locks.request('grigdesk-surface-open', send) : send();
}

/**
 * Потерянное подтверждение не даёт права создавать параллельный диалог.
 * Повторное нажатие безопасно поднимет существующее окно по тому же ключу.
 */
function showOpeningFailure() {
  showToast({
    id: 'task-window-opening',
    title: 'Не удалось подтвердить открытие окна. Нажмите задачу ещё раз.',
    tone: 'warning',
  });
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    taskId: null as string | null,
    taskSource: undefined as TaskSourceId | undefined,
    taskUnavailable: undefined as 'legacy-own' | undefined,
  }),

  actions: {
    /**
     * Все экраны выбирают размещение карточки через один вход по capability оболочки.
     * Документ карточки сохраняет свою цель даже при отказе открытия соседней задачи.
     */
    async openTask(id: string | number, source?: unknown): Promise<void> {
      if (source !== undefined && !isTaskSourceId(source)) {
        showOpeningFailure();

        return;
      }

      const reference = parseTaskReference(isTaskSourceId(source) ? `${source}:${id}` : id);

      if (!reference) {
        showOpeningFailure();

        return;
      }

      id = reference.id;
      source = reference.source;

      const generation = nextGeneration(this);
      const surface = currentDesktopMode() === 'surface';
      const target = parseSurfaceTarget({
        kind: 'task',
        id: String(id),
        ...(source ? { source } : {}),
        ...(reference.unavailable ? { unavailable: reference.unavailable } : {})
      });
      const supported = useShellStore().capabilities.includes('windows')
        && (!source || useShellStore().capabilities.includes('taskSources'))
        && (!reference.unavailable || useShellStore().capabilities.includes('taskSources'));

      if (!target || !supported) {
        if (!surface) {
          this.taskId = String(id);
          this.taskSource = reference.source;
          this.taskUnavailable = reference.unavailable;
        } else {
          showOpeningFailure();
        }

        return;
      }

      const result = await resolveSurfaceOpening(target, supported,
        (value) => sendSurface('/surfaces/open', value));

      if (generations.get(this) !== generation) {
        return;
      }

      if (result === 'unknown') {
        showOpeningFailure();

        return;
      }

      if (surface) {
        if (result === 'inline') {
          const delivered = await resolveSurfaceOpening(target, true,
            () => sendSurface('/surfaces/main', { destination: 'task-dialog', target }));

          if (generations.get(this) === generation && delivered !== 'window') {
            showOpeningFailure();
          }
        }

        return;
      }

      this.taskId = result === 'window' ? null : String(id);
      this.taskSource = result === 'window' ? undefined : reference.source;
      this.taskUnavailable = result === 'window' ? undefined : reference.unavailable;
    },

    /**
     * Доставка из главного окна сохраняет полную цель без повторного выбора размещения.
     * Исторический marker не позволяет открыть внешнюю задачу с тем же номером.
     */
    openTaskInline(id: string | number, source?: TaskSourceId, unavailable?: 'legacy-own') {
      nextGeneration(this);
      this.taskId = String(id);
      this.taskSource = source;
      this.taskUnavailable = unavailable;
    },

    /**
     * Закрытие отменяет применение поздних ответов и очищает всю цель карточки.
     * Следующее открытие не наследует исторический признак отсутствия задачи.
     */
    close() {
      nextGeneration(this);
      this.taskId = null;
      this.taskSource = undefined;
      this.taskUnavailable = undefined;
    },
  },
});
