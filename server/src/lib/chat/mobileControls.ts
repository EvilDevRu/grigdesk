import { ChatHistoryError } from './historyStore.ts';
import type { ChatHistoryStore, StoredChat } from './historyStore.ts';
import { migrateChatModelRecord, normalizeModelRef, resolveModelRef } from './modelRef.ts';
import type { ModelRegistry } from './modelRef.ts';
import { EMPTY_WORKDIR_MEMORY } from './workdirTransition.ts';

export type MobileSettingsInput = {
  expectedRevision: number;
  modelRef: unknown;
  effort: string;
  reset: boolean;
};

type Ports = {
  history: ChatHistoryStore;
  registry: () => Promise<ModelRegistry>;
  busy: (id: string) => boolean;
  lock: <T>(id: string, action: () => Promise<T>) => Promise<T>;
  reset: (chat: StoredChat) => Promise<void>;
  changed: (id: string) => void;
};

/**
 * Мобильные настройки используют тот же admission и историю, что обычный чат.
 * Сброс памяти и запись модели не допускают вклинивания PUT с другого устройства.
 */
export class MobileChatControls {
  private ports: Ports;

  constructor(ports: Ports) {
    this.ports = ports;
  }

  /**
   * Повтор одного мобильного намерения узнаётся по серверному id и не меняет созданный чат.
   * Модель проверяется по текущему реестру, история создаётся без запуска исполнителя.
   */
  async create(id: string, modelRef: unknown) {
    this.idle(id);

    return this.ports.lock(id, async () => {
      const existing = await this.ports.history.readOne(id);

      if (existing) {
        if (existing.mobileCreationId !== id) {
          throw new ChatHistoryError('chat_exists', 'Чат уже существует.');
        }

        return existing;
      }

      const registry = await this.ports.registry();
      const selected = this.selection(modelRef, '', registry);
      const now = Date.now();

      await this.ports.history.saveOne({
        id,
        mobileCreationId: id,
        title: 'Новый чат',
        modelRef: selected.modelRef,
        effort: '',
        taskId: null,
        workdir: { kind: 'grigdesk' },
        messages: [],
        createdAt: now,
        updatedAt: now,
      });

      const saved = await this.ports.history.patchExecution(id, () => ({}), {
        durable: true,
        skipUnchanged: true,
      });

      this.ports.changed(id);

      return saved;
    });
  }

  /**
   * Ревизия проверяется под history lock до сброса сессии и изменения выбранной модели.
   * Смена исполнителя требует явного подтверждения; сообщение и папка здесь не меняются.
   */
  async configure(id: string, input: MobileSettingsInput) {
    this.idle(id);

    const saved = await this.ports.lock(id, () => this.ports.history.patchExecution(id, async (current) => {
      this.revision(current, input.expectedRevision);

      const registry = await this.ports.registry();
      const selected = this.selection(input.modelRef, input.effort, registry);
      const previous = normalizeModelRef(current.modelRef);
      const changing = Boolean(previous && previous.provider !== selected.modelRef.provider);

      if (changing && !input.reset) {
        throw new ChatHistoryError('reset_required', 'Подтвердите сброс памяти при смене исполнителя.');
      }
      if (changing) {
        await this.ports.reset(current);
      }

      const migrated = migrateChatModelRecord({ ...current, modelRef: selected.modelRef }, registry).chat;

      return {
        ...(changing ? {
          ...EMPTY_WORKDIR_MEMORY,
          mode: '',
          executionRunId: null,
          workdirState: {
            ...current.workdirState,
            seed: '',
            seedClaim: null,
          },
        } : {}),
        modelRef: migrated.modelRef,
        modelRefState: migrated.modelRefState,
        model: migrated.model,
        effort: input.effort,
      };
    }, { durable: true, skipUnchanged: true }));

    this.ports.changed(id);

    return saved;
  }

  /**
   * Отметка чтения касается только показанной ревизии: новый ответ не гасится старым экраном.
   * Она использует общий unread веба и не переписывает сообщения устаревшим снимком.
   */
  async read(id: string, expectedRevision: number) {
    const saved = await this.ports.history.patchExecution(id, (current) => {
      this.revision(current, expectedRevision);

      return { unread: false };
    }, { durable: true, skipUnchanged: true });

    this.ports.changed(id);

    return saved;
  }

  /**
   * Блокировка резервируется синхронно после этой проверки, до первого чтения диска.
   * Принятый ход, перенос папки и удаление имеют приоритет над настройкой следующего хода.
   */
  private idle(id: string) {
    if (this.ports.busy(id)) {
      throw new ChatHistoryError('chat_busy', 'Дождитесь окончания хода или остановите его.');
    }
  }

  /**
   * CAS отвергает устаревшее решение вместо тихого сохранения части его параметров.
   * Поддельные или отсутствующие номера ревизии также не дают права на изменение.
   */
  private revision(chat: StoredChat, expected: number) {
    if (!Number.isSafeInteger(expected) || expected < 0 || Number(chat.revision || 0) !== expected) {
      throw new ChatHistoryError('state_changed', 'Чат изменился; перечитайте его перед изменением.');
    }
  }

  /**
   * Принимает только зарегистрированную пару и объявленный ею уровень усилия.
   * Доступность аккаунта не удаляет сохранённые модели из выбора пользователя.
   */
  private selection(modelRef: unknown, effort: string, registry: ModelRegistry) {
    const selected = resolveModelRef(modelRef, registry);

    if (!selected.ok) {
      throw new ChatHistoryError('unknown_model', 'Выберите модель из актуального каталога.');
    }

    const levels = (selected.model as { efforts?: string[] }).efforts || [];

    if (effort && !levels.includes(effort)) {
      throw new ChatHistoryError('unsupported_effort', 'Модель не поддерживает выбранное усилие.');
    }

    return selected;
  }
}
