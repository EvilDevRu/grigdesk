import { isTaskSourceId, parseTaskReference } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import { defineStore } from 'pinia';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';


import { parseSurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';
import type { SurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';
import { currentDesktopMode } from '../shared/desktopSettings.ts';
import { resolveSurfaceOpening } from '../shared/surfaceLauncher.ts';
import { shellAction } from '../shared/shellClient.ts';
import { showToast } from '../ui';
import { useShellStore } from './shell.ts';

const t = localeTranslator(uiLocalePort);

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

function showTaskInMain(target: Extract<SurfaceTarget, { kind: 'task' }>) {
  return resolveSurfaceOpening(target, true,
    (value) => sendSurface('/surfaces/main', { destination: 'task-dialog', target: value }));
}

/**
 * Ошибка разбора ссылки или доставки в главный документ оставляет текущую цель.
 * Подсказка предлагает повторить выбор задачи вручную.
 */
function showOpeningFailure() {
  showToast({
    id: 'task-window-opening',
    title: t('core.coreNeUdalosPodtverditOtkrytie'),
    tone: 'warning',
  });
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    taskId: null as string | null,
    taskSource: undefined as TaskSourceId | undefined,
    taskUnavailable: undefined as 'legacy-own' | undefined,
    taskWindowMoving: false,
  }),

  getters: {
    // Перенос доступен в обоих окнах совместимой оболочки и сохраняет полную цель задачи.
    // Диалог умеет показывать в том числе номера, которые не входят в контракт native-окон.
    taskWindowTarget(state) {
      if (!state.taskId || currentDesktopMode() === 'page') {
        return null;
      }

      const { capabilities } = useShellStore();

      if (!capabilities.includes('windows')
        || ((state.taskSource || state.taskUnavailable) && !capabilities.includes('taskSources'))) {
        return null;
      }

      const target = parseSurfaceTarget({
        kind: 'task',
        id: state.taskId,
        source: state.taskSource,
        unavailable: state.taskUnavailable,
      });

      return target?.kind === 'task' ? target : null;
    },
  },

  actions: {
    /**
     * Обычный выбор открывает диалог. Из отдельного окна действие передаётся
     * главному документу, чтобы сохранить открытую карточку и её черновик.
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

      if (currentDesktopMode() !== 'surface') {
        this.openTaskInline(reference.id, reference.source, reference.unavailable);

        return;
      }

      const target = parseSurfaceTarget({ kind: 'task', ...reference });

      if (target?.kind !== 'task' || !useShellStore().capabilities.includes('windows')) {
        showOpeningFailure();

        return;
      }

      const generation = nextGeneration(this);

      this.taskWindowMoving = false;

      const result = await showTaskInMain(target);

      if (generations.get(this) === generation && result !== 'window') {
        showOpeningFailure();
      }
    },

    /**
     * Переносит текущую карточку и закрывает её только после подтверждения другого окна.
     * Поздний ответ не затрагивает карточку, которую человек открыл после запроса.
     */
    async moveTaskWindow(): Promise<void> {
      const target = this.taskWindowTarget;

      if (!target || this.taskWindowMoving) {
        return;
      }

      const generation = nextGeneration(this);
      const attaching = currentDesktopMode() === 'surface';

      this.taskWindowMoving = true;

      const result = await (attaching ? showTaskInMain(target) : resolveSurfaceOpening(target, true,
        (value) => sendSurface('/surfaces/open', value)));

      if (generations.get(this) !== generation) {
        return;
      }

      this.taskWindowMoving = false;

      if (result === 'window') {
        this.close();
      } else {
        showToast({
          id: 'task-window-opening',
          title: attaching ? t('core.taskAttachFailed') : t('core.taskDetachFailed'),
          tone: 'warning',
        });
      }
    },

    /**
     * Диалог и начальная загрузка отдельного окна используют одну полную цель.
     * Исторический marker не позволяет открыть внешнюю задачу с тем же номером.
     */
    openTaskInline(id: string | number, source?: TaskSourceId, unavailable?: 'legacy-own') {
      nextGeneration(this);
      this.taskId = String(id);
      this.taskSource = source;
      this.taskUnavailable = unavailable;
      this.taskWindowMoving = false;
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
      this.taskWindowMoving = false;
    },
  },
});
