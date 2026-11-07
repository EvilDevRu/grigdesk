import { decodeContract } from './contract.ts';
import type {
  Accepted,
  AppUpdate,
  TrackerTask,
  TrackerTasks,
  Chat,
  ChatOptions,
  ChatResult,
  ModelRef,
  WorkdirChoice,
  WorkspacePreview,
  Attention,
  Chats,
  Deliveries,
  Hello,
  LaunchOptions,
  Operation,
  Task,
  Tasks,
  TextPage,
  Waiting,
  WaitingAnswer,
} from './contract.ts';
import type { GrigDeskLink, OperationIntent } from '../link/types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly operation?: OperationIntent;

  constructor(status: number, code: string, message: string, operation?: OperationIntent) {
    super(message);
    this.status = status;
    this.code = code;
    this.operation = operation;
  }
}

type Options = {
  sleep?: (milliseconds: number) => Promise<void>;
  fatal?: (code: string) => void;
  canMutate?: () => boolean;
};

/**
 * Намерение создаётся один раз до native durable сохранения, вместе с clientId.
 * Сетевые повторы и восстановление UI используют прежние key/body/createdAt.
 */
export function messageIntent(chatId: string, text: string): OperationIntent {
  const clientId = crypto.randomUUID();

  return {
    method: 'POST',
    path: `/api/mobile/v1/chats/${encodeURIComponent(chatId)}/messages`,
    body: JSON.stringify({
      text,
      clientId,
    }),
    clientId,
    chatId,
    idempotencyKey: crypto.randomUUID(),
    createdAt: Date.now(),
  };
}

/**
 * Очередь UI расширяет намерение состоянием доставки и текстом ошибки.
 * Native получает только транспортный контракт, сохраняя идентичность повторов.
 */
function transportIntent(intent: OperationIntent): OperationIntent {
  const operation: OperationIntent = {
    method: intent.method,
    path: intent.path,
    body: intent.body,
    idempotencyKey: intent.idempotencyKey,
    createdAt: intent.createdAt,
  };

  for (const field of ['clientId', 'chatId', 'order'] as const) {
    if (intent[field] !== undefined) {
      Object.assign(operation, { [field]: intent[field] });
    }
  }

  return operation;
}

/**
 * Единственный клиент обслуживает JSON v1 и четыре сетевые попытки одной операции.
 * 202 pending разбирается до route decoder; прикладные отказы никогда не повторяют эффект.
 */
export class ApiClient {
  readonly link: GrigDeskLink;
  private options: Options;

  constructor(link: GrigDeskLink, options: Options = {}) {
    this.link = link;
    this.options = options;
  }

  /**
   * Ответ привязан к актуальному unlock/connection generation до помещения в UI.
   * Native выполняет такой же барьер, а контракт проверяется до чтения полей ответа.
   */
  async call<T>(
    kind: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    intent?: OperationIntent,
  ): Promise<T> {
    if (method === 'POST') {
      this.requireCompatible();
    }

    const initial = await this.link.getState();

    if (initial.revoked || !initial.unlocked) {
      const code = initial.revoked ? 'device_revoked' : 'locked';

      this.options.fatal?.(code);

      throw new ApiError(
        initial.revoked ? 403 : 0,
        code,
        initial.revoked
          ? 'Телефон отозван в GrigDesk.'
          : 'Приложение заблокировано. Подтвердите вход.',
      );
    }

    const source =
      method === 'POST'
        ? intent || {
            method,
            path,
            body: JSON.stringify(body),
            idempotencyKey: crypto.randomUUID(),
            createdAt: Date.now(),
          }
        : undefined;
    const operation = source ? transportIntent(source) : undefined;
    const attempts = method === 'POST' ? 4 : 1;

    if (operation) {
      await this.link.putOutbox({ item: operation });
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (method === 'POST') {
        this.requireCompatible();
      }

      try {
        const response = await this.link.request(
          operation || {
            method,
            path,
          },
        );
        const state = await this.link.getState();

        if (state.revoked) {
          throw new ApiError(403, 'device_revoked', 'Телефон отозван в GrigDesk.', operation);
        }
        if (
          !state.unlocked ||
          state.generation !== initial.generation ||
          response.generation !== state.generation
        ) {
          throw new ApiError(0, 'locked', 'Связь изменилась; перечитайте экран.', operation);
        }

        let value: any;

        try {
          value = JSON.parse(response.body);
        } catch {
          throw new ApiError(response.status, 'contract', 'Ответ GrigDesk повреждён.', operation);
        }

        if (response.status === 202 && value.operationPending === true) {
          throw new ApiError(202, 'operation_pending', 'Проверяем доставку.', operation);
        }
        if (!response.status || response.status >= 400) {
          throw new ApiError(
            response.status,
            value.error || 'network',
            value.message || 'Нет связи с GrigDesk.',
            operation,
          );
        }

        let decoded: T;

        try {
          decoded = decodeContract<T>(kind, value);
        } catch {
          throw new ApiError(
            response.status,
            'contract',
            'Обновите приложение: ответ не поддерживается.',
            operation,
          );
        }

        if (operation) {
          await this.link.removeOutbox({ idempotencyKey: operation.idempotencyKey });
        }

        return decoded;
      } catch (error) {
        const failure =
          error instanceof ApiError
            ? error
            : new ApiError(0, 'network', 'Нет связи с GrigDesk.', operation);

        if (
          ['locked', 'device_revoked', 'device_unknown', 'pin_mismatch', 'contract'].includes(
            failure.code,
          )
        ) {
          this.options.fatal?.(failure.code);
        }
        if (failure.code !== 'network' || attempt === attempts - 1) {
          throw failure;
        }

        const sleep =
          this.options.sleep || ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

        await sleep(1000 * 2 ** attempt);

        if ((await this.link.getState()).generation !== initial.generation) {
          throw new ApiError(0, 'locked', 'Связь изменилась.', operation);
        }
      }
    }

    throw new ApiError(0, 'network', 'Нет связи с GrigDesk.', operation);
  }

  /**
   * Минимальная версия проверяется до создания intent и перед каждым сетевым повтором.
   * Уже сохранённая очередь остаётся на устройстве до совместимого обновления приложения.
   */
  private requireCompatible() {
    if (this.options.canMutate?.() === false) {
      throw new ApiError(426, 'update_required', 'Обновите приложение перед отправкой действий.');
    }
  }

  getHello() {
    return this.call<Hello>('hello', 'GET', '/api/mobile/v1/hello');
  }

  getChats(cursor?: string) {
    return this.call<Chats>('chats', 'GET', '/api/mobile/v1/chats' + query({ cursor }));
  }

  getChatOptions() {
    return this.call<ChatOptions>('chat-options', 'GET', '/api/mobile/v1/chat-options');
  }

  getAttention() {
    return this.call<Attention>('attention', 'GET', '/api/mobile/v1/attention');
  }

  createChat(modelRef: ModelRef, intent?: OperationIntent) {
    return this.call<ChatResult>('chat-result', 'POST', '/api/mobile/v1/chats', { modelRef }, intent);
  }

  configureChat(id: string, body: {
    modelRef: ModelRef;
    effort: string;
    reset: boolean;
    actionToken: string;
  }, intent?: OperationIntent) {
    return this.call<ChatResult>(
      'chat-result', 'POST', `/api/mobile/v1/chats/${encodeURIComponent(id)}/settings`, body, intent,
    );
  }

  previewWorkspace(id: string, taskId: string | null, workdir: WorkdirChoice, intent?: OperationIntent) {
    return this.call<WorkspacePreview>(
      'workspace-preview', 'POST', `/api/mobile/v1/chats/${encodeURIComponent(id)}/workspace/preview`,
      { taskId, workdir }, intent,
    );
  }

  changeWorkspace(id: string, actionToken: string, transfer: 'resume' | 'summary' | 'reset',
    intent?: OperationIntent) {
    return this.call<ChatResult>(
      'chat-result', 'POST', `/api/mobile/v1/chats/${encodeURIComponent(id)}/workspace`,
      { actionToken, transfer }, intent,
    );
  }

  /**
   * Автоматическая отметка не оставляет в очереди доказанно отклонённый устаревший CAS.
   * Неоднозначный сетевой итог сохраняет исходное намерение для штатной сверки операций.
   */
  async readChat(id: string, actionToken: string) {
    try {
      return await this.call<ChatResult>(
        'chat-result', 'POST', `/api/mobile/v1/chats/${encodeURIComponent(id)}/read`, { actionToken },
      );
    } catch (error) {
      if (error instanceof ApiError && error.operation && error.status >= 400 && error.status < 500
        && !['operation_unknown', 'idempotency_conflict'].includes(error.code)) {
        await this.link.removeOutbox({ idempotencyKey: error.operation.idempotencyKey });
      }

      throw error;
    }
  }

  getChat(id: string, before?: number, revision?: number) {
    return this.call<Chat>(
      'chat',
      'GET',
      `/api/mobile/v1/chats/${encodeURIComponent(id)}` +
        query({
          before,
          revision,
        }),
    );
  }

  sendMessage(chatId: string, text: string, intent = messageIntent(chatId, text)) {
    return this.call<Accepted>('accepted', 'POST', intent.path, undefined, intent);
  }

  getDeliveries(id: string, ids: string[]) {
    return this.call<Deliveries>(
      'deliveries',
      'GET',
      `/api/mobile/v1/chats/${encodeURIComponent(id)}/deliveries` + query({ ids: ids.join(',') }),
    );
  }

  getOperation(key: string) {
    return this.call<Operation>(
      'operations',
      'GET',
      `/api/mobile/v1/operations/${encodeURIComponent(key)}`,
    );
  }

  getWaiting(cursor?: string) {
    return this.call<Waiting>('waiting', 'GET', '/api/mobile/v1/waiting' + query({ cursor }));
  }

  getWaitingDetails(pid: string, offset?: number, contentRevision?: string) {
    return this.call<TextPage>(
      'details',
      'GET',
      `/api/mobile/v1/waiting/${encodeURIComponent(pid)}/details` +
        query({
          offset,
          contentRevision,
        }),
    );
  }

  answerWaiting(pid: string, body: WaitingAnswer) {
    return this.call<{
      ok: true;
      commentDelivered?: boolean;
      textDelivered?: boolean;
    }>('waiting-result', 'POST', `/api/mobile/v1/waiting/${encodeURIComponent(pid)}`, body);
  }

  stopChat(id: string, actionToken: string) {
    return this.call('stop', 'POST', `/api/mobile/v1/chats/${encodeURIComponent(id)}/stop`, {
      actionToken,
    });
  }

  getTasks(cursor?: string) {
    return this.call<Tasks>('tasks', 'GET', '/api/mobile/v1/tasks' + query({ cursor }));
  }

  getTask(id: string) {
    return this.call<Task>('task', 'GET', `/api/mobile/v1/tasks/${encodeURIComponent(id)}`);
  }

  getPlan(id: string, offset?: number, contentRevision?: string) {
    return this.call<TextPage>(
      'plan',
      'GET',
      `/api/mobile/v1/tasks/${encodeURIComponent(id)}/plan` +
        query({
          offset,
          contentRevision,
        }),
    );
  }

  gateTask(
    id: string,
    body: {
      gate: string;
      decision: 'approve' | 'reject';
      comment: string;
      actionToken: string;
    },
  ) {
    return this.call<{
      ok: true;
      resumed: boolean;
      resumeError: string | null;
    }>('gate', 'POST', `/api/mobile/v1/tasks/${encodeURIComponent(id)}/gate`, body);
  }

  taskAction(id: string, action: 'resume' | 'stop', actionToken: string) {
    return this.call(action, 'POST', `/api/mobile/v1/tasks/${encodeURIComponent(id)}/${action}`, {
      actionToken,
    });
  }

  getTrackerTasks(cursor?: string) {
    return this.call<TrackerTasks>('tracker-tasks', 'GET', '/api/mobile/v1/tracker/tasks' + query({ cursor }));
  }

  getTrackerTask(id: string) {
    return this.call<TrackerTask>(
      'tracker-task',
      'GET',
      `/api/mobile/v1/tracker/tasks/${encodeURIComponent(id)}`,
    );
  }

  getLaunchOptions(id: string) {
    return this.call<LaunchOptions>(
      'launch-options',
      'GET',
      `/api/mobile/v1/tracker/tasks/${encodeURIComponent(id)}/launch-options`,
    );
  }

  launchTrackerTask(id: string, optionId: string, actionToken: string) {
    return this.call(
      'launch',
      'POST',
      `/api/mobile/v1/tracker/tasks/${encodeURIComponent(id)}/launch`,
      {
        optionId,
        actionToken,
      },
    );
  }

  getApp() {
    return this.call<AppUpdate>('app', 'GET', '/api/mobile/v1/app');
  }
}

/**
 * Параметры кодируются один раз; неопределённые значения не превращаются в строку undefined.
 * Число/текст передаются без возможности добавить собственный маршрут или заголовок.
 */
function query(values: Record<string, string | number | undefined>) {
  const result = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result.set(key, String(value));
    }
  }

  return result.size ? '?' + result.toString() : '';
}
