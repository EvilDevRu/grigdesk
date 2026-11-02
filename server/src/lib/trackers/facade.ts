import { isRecord } from '../../../../shared/lib/objects.ts';
import { NO_TRACKER_CAPABILITIES } from '../../../../shared/trackers/contracts.ts';
import { TrackerError } from './contract.ts';
import type { TaskData, TaskTracker, TrackerIdentity, TrackerReadOptions } from './contract.ts';
import type { ChecklistItemInput, ChecklistItemUpdate } from './contract.ts';
import type { TrackerRegistry } from './registry.ts';
import type { TrackerSettingsStore } from './settingsStore.ts';
import type { TrackerCapabilities } from '../../../../shared/trackers/contracts.ts';

export interface TrackerContext {
  trackerId: string | null;
  revision: number;
}

export class TrackerFacade {
  private readonly registry: TrackerRegistry;
  private readonly selection: TrackerSettingsStore;

  constructor(options: {
    registry: TrackerRegistry;
    selection: TrackerSettingsStore;
  }) {
    this.registry = options.registry;
    this.selection = options.selection;
  }

  captureContext(): TrackerContext {
    const { externalId, revision } = this.selection.read();

    return { trackerId: externalId, revision };
  }

  /**
   * Проверяет поколение непосредственно перед допуском эффекта.
   * Старые клиенты без заголовка используют текущий выбор, как прежний HTTP и CLI.
   */
  assertContext(context: TrackerContext | number): void {
    const current = this.captureContext();
    const valid = typeof context === 'number' ? context === current.revision
      : context.revision === current.revision && context.trackerId === current.trackerId;

    if (!valid) {
      throw new TrackerError('tracker_context_changed', 'Подключение трекера изменилось', 409);
    }
  }

  capabilities(): TrackerCapabilities | undefined {
    const id = this.selection.read().externalId;

    return this.registry.descriptors().find((entry) => entry.id === id)?.capabilities;
  }

  isConfigured(): boolean {
    const id = this.selection.read().externalId;

    return !!id && this.registry.activeIds.includes(id)
      && !!this.registry.descriptors().find((entry) => entry.id === id)?.configured;
  }

  hasSelection(): boolean {
    return this.selection.read().externalId !== null;
  }

  invalidate(): void {
    this.selection.write(this.selection.read().externalId);
  }

  /**
   * Выбор фиксируется до ожидания, а реестр фиксирует экземпляр при допуске.
   * Неподдерживаемый метод отклоняется до вызова драйвера и сетевых эффектов.
   * Внешний пакет имеет свой класс ошибки: отсутствие задачи нормализуется по контракту.
   */
  private invoke<T>(
    operation: (tracker: TaskTracker) => Promise<T>,
    capability?: keyof TrackerCapabilities,
    method?: keyof TaskTracker,
  ): Promise<T> {
    const { externalId } = this.selection.read();

    if (!externalId) {
      return Promise.reject(new TrackerError('tracker_unavailable', 'Внешний трекер не настроен'));
    }

    return this.registry.call(externalId, async (tracker) => {
      if (capability && !tracker.capabilities[capability]) {
        const code = capability === 'delete' ? 'unsupported' : `${capability}_unsupported`;

        throw new TrackerError(code, 'Действие не поддерживается трекером');
      }

      if (method && typeof tracker[method] !== 'function') {
        throw new TrackerError(`${capability}_unsupported`, 'Драйвер не поддерживает это действие');
      }

      try {
        return await operation(tracker);
      } catch (error) {
        if (isRecord(error) && error.code === 'b24_bad_request' && typeof error.message === 'string') {
          throw new TrackerError('b24_bad_request', error.message);
        }

        if (isRecord(error) && error.code === 'task_not_found' && error.status === 404
          && typeof error.message === 'string') {
          throw new TrackerError('task_not_found', error.message, 404);
        }

        throw error;
      }
    });
  }

  /**
   * Проверяет вложения до разрешения имён кадров и загрузки файлов.
   * Отсутствие media-плагина не превращает неподдерживаемое вложение в успешную потерю данных.
   */
  assertAttachments(input: TaskData): void {
    if (this.capabilities()?.attachments) {
      return;
    }

    if (['images', 'frames', 'clips'].some((key) => Array.isArray(input[key]) && input[key].length)) {
      throw new TrackerError('attachments_unsupported', 'Вложения не поддерживаются трекером');
    }
  }

  /**
   * Идентичность внешнего пакета нормализуется до строкового пользовательского id.
   * Пакеты прежней версии с числовым id сохраняют тот же личный scope.
   */
  accountIdentity(options: TrackerReadOptions = {}): Promise<TrackerIdentity | null> {
    return this.invoke(async (tracker) => {
      const identity = await tracker.accountIdentity(options);

      return identity ? { ...identity, userId: String(identity.userId) } : null;
    });
  }

  testAuth() {
    return this.invoke((tracker) => tracker.testAuth());
  }

  /**
   * Старые поля разворачиваются аддитивно, widgets и возможности принадлежат драйверу.
   * Legacy API остаётся адресом внешнего трекера, собственная группа читается отдельно.
   */
  getDashboard(options: TrackerReadOptions = {}): Promise<Record<string, unknown>> {
    const revision = this.selection.read().revision;

    return this.invoke(async (tracker) => {
      const snapshot = await tracker.getDashboard(options);

      return {
        ...snapshot.compatibility,
        ...snapshot,
        trackerId: tracker.id,
        capabilities: { ...NO_TRACKER_CAPABILITIES, ...tracker.capabilities },
        widgets: snapshot.widgets,
        generation: revision,
      };
    });
  }

  taskDetail(id: unknown, options: TrackerReadOptions = {}): Promise<unknown> {
    return this.invoke((tracker) => tracker.taskDetail(String(id), options));
  }

  taskPageData(id: unknown, options: TrackerReadOptions = {}): Promise<unknown> {
    return this.invoke((tracker) => tracker.taskPageData
      ? tracker.taskPageData(String(id), options) : Promise.resolve({ comments: [], attachments: [] }));
  }

  createTask(input: TaskData): Promise<unknown> {
    this.assertAttachments({ ...input });

    return this.invoke((tracker) => tracker.createTask!({ ...input }), 'create');
  }

  updateTask(id: unknown, input: unknown): Promise<unknown> {
    return this.invoke((tracker) => tracker.updateTask!(String(id), input), 'editing');
  }

  addComment(id: unknown, text: unknown): Promise<unknown> {
    return this.invoke((tracker) => tracker.addComment!(String(id), text), 'comments');
  }

  timer(action: unknown, id: unknown): Promise<unknown> {
    return this.invoke((tracker) => tracker.timer!(String(action), String(id)), 'timer');
  }

  completeTask(id: unknown): Promise<unknown> {
    return this.invoke((tracker) => tracker.completeTask!(String(id)), 'complete');
  }

  deleteTask(id: string): Promise<{ ok: boolean }> {
    return this.invoke((tracker) => tracker.deleteTask!(id), 'delete');
  }

  renewTask(id: unknown): Promise<unknown> {
    return this.invoke((tracker) => tracker.renewTask!(String(id)), 'renew', 'renewTask');
  }

  addChecklistItem(id: string, input: ChecklistItemInput): Promise<unknown> {
    return this.invoke((tracker) => tracker.addChecklistItem!(id, input), 'checklist', 'addChecklistItem');
  }

  updateChecklistItem(id: string, itemId: string, input: ChecklistItemUpdate): Promise<unknown> {
    return this.invoke((tracker) => tracker.updateChecklistItem!(id, itemId, input),
      'checklist', 'updateChecklistItem');
  }

  deleteChecklistItem(id: string, itemId: string): Promise<unknown> {
    return this.invoke((tracker) => tracker.deleteChecklistItem!(id, itemId),
      'checklist', 'deleteChecklistItem');
  }

  updateTaskTags(id: string, tags: string[]): Promise<unknown> {
    return this.invoke((tracker) => tracker.updateTaskTags!(id, tags), 'tags', 'updateTaskTags');
  }

  approveTask(id: string): Promise<unknown> {
    return this.invoke((tracker) => tracker.approveTask!(id), 'review', 'approveTask');
  }

  disapproveTask(id: string): Promise<unknown> {
    return this.invoke((tracker) => tracker.disapproveTask!(id), 'review', 'disapproveTask');
  }

  findUsers(query: unknown, options: TrackerReadOptions = {}): Promise<unknown> {
    return this.invoke((tracker) => tracker.findUsers!(String(query), options), 'users');
  }

  listGroups(options: TrackerReadOptions = {}): Promise<unknown> {
    return this.invoke((tracker) => tracker.listGroups!(options), 'projects');
  }

  sourceUrl(id: string): Promise<string> {
    return this.invoke(async (tracker) => tracker.sourceUrl(id));
  }

  /**
   * Недоступный выбранный драйвер не доказывает отсутствие внешнего номера.
   * Own получает unknown и сохраняет прежний отказ безопасной выдачи номера.
   */
  async probeTaskNumber(id: string) {
    try {
      return await this.invoke((tracker) => tracker.probeTaskNumber(id));
    } catch {
      return 'unknown' as const;
    }
  }
}
