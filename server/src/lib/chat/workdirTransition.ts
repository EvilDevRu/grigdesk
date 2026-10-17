import { randomUUID } from 'node:crypto';

import {
  chatWorkdirLabel,
  normalizeChatWorkdir,
  sameChatWorkdir,
} from '../../../../shared/chat/chatWorkdir.ts';
import type { ChatWorkdir, WorkdirCapability } from '../../../../shared/chat/chatWorkdir.ts';
import { ChatWorkdirError } from './workdir.ts';
import type { ResolvedWorkdir } from './workdir.ts';
import type { ChatHistoryStore, StoredChat } from './historyStore.ts';

export interface WorkdirTransition {
  id: string;
  request: string;
  phase: 'preparing' | 'ready' | 'resetting' | 'done' | 'failed';
  target: ResolvedWorkdir;
  transfer: 'resume' | 'summary' | 'reset';
  reset: boolean;
  // Папка, из которой уходит разговор: снимок на начало операции, чтобы плашка после
  // рестарта сервера называла её так же.
  from?: string;
  priorSeed?: string;
  error?: string;
}

export interface WorkdirState {
  epoch?: number;
  committed?: ResolvedWorkdir;
  sessionWorkspace?: ResolvedWorkdir;
  seed?: string;
  seedClaim?: { id: string; sessionId?: string | null; } | null;
  transition?: WorkdirTransition;
}

interface Selection {
  taskId: string | null;
  workdir: ChatWorkdir;
}

interface ChangeInput extends Selection {
  operationId: string;
  expectedRevision: number;
  expectedWorkspaceKey: string;
  transfer: 'resume' | 'summary' | 'reset';
}

interface TransitionPorts {
  history: ChatHistoryStore;
  busy: (id: string) => boolean;
  lock: <T>(id: string, run: () => Promise<T>) => Promise<T>;
  resolve: (record: StoredChat, selection?: Selection) => Promise<ResolvedWorkdir>;
  capability: (record: StoredChat) => Promise<WorkdirCapability | null>;
  memory: (record: StoredChat) => Promise<{ sessionId: string | null; workspace?: ResolvedWorkdir; }>;
  summary: (record: StoredChat, workspace: ResolvedWorkdir, sessionId: string) => Promise<string>;
  reset: (record: StoredChat) => Promise<void>;
  notify: (id: string) => void;
}

/**
 * Плашка перехода нужна только разговору: пустому чату переносить нечего, а выбор той же
 * папки без сброса памяти для агента ничего не меняет. Иначе история получает одну строку.
 */
function withTransitionNote(messages: StoredChat['messages'], note: {
  from: string;
  to: string;
  suffix: string;
  reset: boolean;
  operationId: string;
}) {
  const list = messages || [];
  const conversation = list.some((message) => message.role === 'user' || message.role === 'assistant');

  if (!conversation || (note.from === note.to && !note.reset)) {
    return list;
  }

  const route = note.from === note.to ? note.to : `${note.from} → ${note.to}`;

  return [...list, {
    role: 'note',
    text: `📁 Папка: ${route}${note.suffix}`,
    operationId: note.operationId,
  }];
}

export const EMPTY_WORKDIR_MEMORY = {
  sessionId: null,
  executionRunId: null,
  pendingSeed: '',
  contextTokens: 0,
  contextWindow: 0,
  contextMetric: '',
  contextIsEstimate: false,
  totalInputTokens: 0,
  cachedInputTokens: 0,
  contextCache: null,
  compactedAt: 0,
};

/**
 * Номер задачи нормализуется независимо от содержимого страницы.
 * Пустое значение означает снятие привязки, остальные значения должны быть каноническими.
 */
export function workdirTaskId(value: unknown): string | null {
  if (value == null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value)) {
    throw new ChatWorkdirError('bad_task_id', 'Нужен канонический номер задачи.', 400);
  }

  return value;
}

/**
 * Сервер хранит единственную операцию, отдельно от истории сообщений.
 * Переход и восстановление пользуются уже существующей блокировкой хода чата.
 */
export class ChatWorkdirTransitions {
  private ports: TransitionPorts;
  private jobs = new Map<string, {
    id: string;
    request: string;
    promise: Promise<StoredChat>;
  }>();

  constructor(ports: TransitionPorts) {
    this.ports = ports;
  }

  isBusy(id: string): boolean {
    return this.jobs.has(id);
  }

  /**
   * Предпросмотр сопоставляет выбранное место с фактической памятью исполнителя.
   * Завершённый перенос без нового хода не предлагается повторно после F5.
   */
  async preview(record: StoredChat, candidate?: Selection) {
    const target = await this.ports.resolve(record, candidate);
    const capability = await this.ports.capability(record);
    const memory = await this.ports.memory(record);
    const committed = record.workdirState?.committed;
    // Невалидный прежний выбор не запрещает исправить папку. Для выжимки всё равно
    // нужен фактический снимок сессии, а для явного reset он не требуется.
    const current = committed || memory.workspace || null;
    const alreadyCommitted = committed?.workspaceKey === target.workspaceKey;
    const sameRoots = memory.workspace?.cwd === target.cwd
      && memory.workspace.provider === target.provider
      && JSON.stringify(memory.workspace.extraDirs) === JSON.stringify(target.extraDirs);
    const hasSeed = Boolean(record.workdirState?.seed || record.pendingSeed);
    const transfer = !memory.sessionId || sameRoots || alreadyCommitted
      ? 'none'
      : capability?.switch ?? 'unavailable';

    return {
      current,
      target,
      revision: record.revision ?? 0,
      workspaceKey: target.workspaceKey,
      transfer,
      summaryAvailable: hasSeed || Boolean(memory.sessionId && memory.workspace),
      capability,
    };
  }

  /**
   * Резервирование синхронно закрывает окно между busy-проверкой и чтением диска.
   * Повтор того же запроса получает существующую работу, не второй запрос к модели.
   */
  change(id: string, raw: unknown): Promise<StoredChat> {
    const input = this.input(raw);
    const request = JSON.stringify(input);
    const running = this.jobs.get(id);

    if (running) {
      if (running.id === input.operationId && running.request === request) {
        return running.promise;
      }

      return Promise.reject(new ChatWorkdirError('chat_busy', 'Уже идёт перенос разговора.'));
    }

    const busy = this.ports.busy(id);
    const promise = Promise.resolve().then(async () => {
      const record = await this.record(id);
      const previous = record.workdirState?.transition;

      if (previous?.id === input.operationId) {
        if (previous.request !== request) {
          throw new ChatWorkdirError(
            'workdir_operation_conflict', 'Этот id уже использован другим переходом.',
          );
        }
        if (['done', 'failed'].includes(previous.phase)) {
          return record;
        }
        if (busy) {
          throw new ChatWorkdirError('chat_busy', 'Чат занят, восстановление переноса ожидает.');
        }

        return this.ports.lock(id, () => this.recover(id));
      }
      if (busy) {
        throw new ChatWorkdirError('chat_busy', 'Сначала дождитесь окончания хода и сохранения чата.');
      }

      return this.ports.lock(id, () => this.perform(record, input, request));
    }).finally(() => {
      this.jobs.delete(id);
      this.ports.notify(id);
    });

    this.jobs.set(id, {
      id: input.operationId,
      request,
      promise
    });

    return promise;
  }

  /**
   * После перезапуска незавершённый сброс доводится до commit до следующего хода.
   * Незаконченный запрос выжимки не повторяется: прежний cwd остаётся выбранным.
   */
  async recover(id: string): Promise<StoredChat> {
    let record = await this.record(id);
    const transition = record.workdirState?.transition;

    if (transition?.phase === 'preparing') {
      record = await this.patch(id, (current) => ({
        workdirState: {
          ...current.workdirState,
          transition: {
            ...transition,
            phase: 'failed',
            error: 'Перенос прерван до сохранения выжимки.'
          },
        },
      }));
    } else if (transition && ['ready', 'resetting'].includes(transition.phase)) {
      record = await this.finish(record);
    }
    if (record.workdirState?.seedClaim) {
      await this.ports.reset(record);
      record = await this.patch(id, (current) => ({
        ...EMPTY_WORKDIR_MEMORY,
        workdirState: { ...current.workdirState, seedClaim: null },
      }));
    }

    return record;
  }

  /**
   * Резерв выжимки пишется до вызова исполнителя; legacy получает внутренний id.
   * Даже при падении процесса текст остаётся в журнале для восстановления.
   */
  async claimSeed(id: string, turnId: string, includePending = false): Promise<string> {
    const record = await this.record(id);
    const seed = record.workdirState?.seed || (includePending ? String(record.pendingSeed || '') : '');

    if (seed) {
      await this.patch(id, (current) => ({
        ...(includePending ? { pendingSeed: '' } : {}),
        workdirState: {
          ...current.workdirState,
          seed,
          seedClaim: { id: turnId || randomUUID(), sessionId: null },
        },
      }));
    }

    return seed;
  }

  /**
   * Только подтверждённый ход освобождает выжимку; обычный PUT её не потребляет.
   * При ошибке сессия сбрасывается, чтобы следующая попытка не дублировала seed в старой памяти.
   */
  async settleSeed(id: string, success: boolean): Promise<boolean> {
    const record = await this.record(id);

    if (!record.workdirState?.seedClaim) {
      return false;
    }
    if (!success) {
      await this.ports.reset(record);
    }

    await this.patch(id, (current) => ({
      ...(success ? {} : EMPTY_WORKDIR_MEMORY),
      workdirState: {
        ...current.workdirState,
        seed: success ? '' : current.workdirState?.seed,
        seedClaim: null,
      },
    }));

    return !success;
  }

  /**
   * Форму операции проверяем до доступа к записи и резервирования.
   * Полное нормализованное тело служит ключом идемпотентности последней операции.
   */
  private input(raw: unknown): ChangeInput {
    const value = (raw || {}) as Partial<ChangeInput>;
    const workdir = normalizeChatWorkdir(value.workdir);

    if (!workdir || !/^[\w-]{8,100}$/u.test(String(value.operationId || ''))
      || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0
      || !value.expectedWorkspaceKey || !['resume', 'summary', 'reset'].includes(value.transfer || '')) {
      throw new ChatWorkdirError(
        'bad_workdir_change', 'Переход требует id, ревизию и проверенный выбор.', 400,
      );
    }

    return {
      operationId: value.operationId!,
      expectedRevision: value.expectedRevision!,
      expectedWorkspaceKey: value.expectedWorkspaceKey,
      taskId: workdirTaskId(value.taskId),
      workdir,
      transfer: value.transfer!,
    };
  }

  /**
   * Выжимка получается до первого разрушительного действия над памятью.
   * Новый журнал подхватывает непотреблённый seed предыдущего перехода одной записью.
   */
  private async perform(record: StoredChat, input: ChangeInput, request: string): Promise<StoredChat> {
    const id = record.id!;

    if (record.purpose === 'companion' && (input.taskId !== (record.taskId || null)
      || input.workdir.kind !== 'cockpit' || !sameChatWorkdir(input.workdir, record.workdir))) {
      throw new ChatWorkdirError('workdir_change_required', 'Папка компаньона определяется его задачей.');
    }
    if (record.revision !== input.expectedRevision) {
      throw new ChatWorkdirError('stale_chat_workdir', 'Чат изменился в другом окне; перечитайте его.');
    }

    const previous = record.workdirState?.transition;

    if (previous && !['done', 'failed'].includes(previous.phase)) {
      throw new ChatWorkdirError('chat_busy', 'Предыдущий переход требует восстановления.');
    }

    const preview = await this.preview(record, input);
    const memory = await this.ports.memory(record);

    if (preview.workspaceKey !== input.expectedWorkspaceKey) {
      throw new ChatWorkdirError('stale_chat_workdir', 'Пути изменились после предпросмотра.');
    }
    if ((preview.transfer === 'unavailable' && input.transfer !== 'reset')
      || (preview.transfer === 'reseed' && input.transfer === 'resume')) {
      throw new ChatWorkdirError(
        'workdir_transfer_required', 'Исполнитель требует выжимку или сброс памяти.',
      );
    }

    const reset = input.transfer === 'reset' || (input.transfer === 'summary' && Boolean(memory.sessionId));
    const transition: WorkdirTransition = {
      id: input.operationId,
      request,
      phase: 'preparing',
      target: preview.target,
      transfer: input.transfer,
      reset,
      from: await this.origin(record, preview.current),
      priorSeed: record.workdirState?.seed || String(record.pendingSeed || ''),
    };

    record = await this.patch(id, (current) => {
      if (current.revision !== input.expectedRevision) {
        throw new ChatWorkdirError('stale_chat_workdir', 'Запись чата изменилась до начала переноса.');
      }

      return {
        pendingSeed: '',
        workdirState: {
          ...current.workdirState,
          committed: current.workdirState?.committed || preview.current || undefined,
          sessionWorkspace: current.workdirState?.sessionWorkspace || memory.workspace,
          seed: current.workdirState?.seed || String(current.pendingSeed || ''),
          transition,
        },
      };
    });

    try {
      let seed = record.workdirState?.seed || '';

      if (input.transfer === 'summary' && memory.sessionId && !seed) {
        if (!memory.workspace) {
          throw new ChatWorkdirError(
            'workdir_origin_unknown', 'Прежняя папка неизвестна; доступен явный сброс.',
          );
        }

        seed = (await this.ports.summary(record, memory.workspace, memory.sessionId)).trim();

        if (!seed) {
          throw new ChatWorkdirError('workdir_summary_empty', 'Исполнитель не вернул выжимку.');
        }
      }

      record = await this.patch(id, (current) => ({
        workdirState: {
          ...current.workdirState,
          seed,
          transition: { ...transition, phase: 'ready' },
        },
      }));
    } catch (error) {
      await this.patch(id, (current) => ({
        workdirState: {
          ...current.workdirState,
          transition: {
            ...transition,
            phase: 'failed',
            error: (error as Error).message
          },
        },
      }));

      throw error;
    }

    return this.finish(record);
  }

  /**
   * Commit накладывает только execution-поля на актуальную историю.
   * Сбой сброса оставляет фазу resetting и seed, чтобы следующий запрос восстановил операцию.
   */
  private async finish(record: StoredChat): Promise<StoredChat> {
    const id = record.id!;
    const transition = record.workdirState!.transition!;

    try {
      const currentTarget = await this.ports.resolve(record, transition.target);

      if (currentTarget.workspaceKey !== transition.target.workspaceKey) {
        throw new ChatWorkdirError('stale_chat_workdir', 'Целевая папка изменилась; выберите её заново.');
      }
    } catch (error) {
      // После resetting неизвестно, успел ли завершиться внешний сброс. Повторяем его
      // и сохраняем выжимку; до этой фазы прежнюю память и прежний seed можно оставить.
      const resetting = transition.phase === 'resetting';

      if (resetting) {
        await this.ports.reset(record);
      }

      await this.patch(id, (current) => ({
        ...(resetting ? EMPTY_WORKDIR_MEMORY : {}),
        workdirState: {
          ...current.workdirState,
          seed: resetting ? current.workdirState?.seed : transition.priorSeed || '',
          transition: {
            ...transition,
            phase: 'failed',
            error: (error as Error).message
          },
        },
      }));

      throw error;
    }

    if (transition.reset) {
      record = await this.patch(id, (current) => ({
        workdirState: {
          ...current.workdirState,
          transition: { ...transition, phase: 'resetting' },
        },
      }));
      await this.ports.reset(record);
    }

    const from = transition.from || record.workdirState?.committed?.cwd || chatWorkdirLabel(record.workdir);
    const suffix = transition.transfer === 'reset' ? ' — память агента сброшена'
      : record.workdirState?.seed ? ' — новая сессия с выжимкой' : '';

    return this.patch(id, (current) => ({
      ...(transition.reset ? EMPTY_WORKDIR_MEMORY : {}),
      executionRunId: null,
      taskId: transition.target.taskId,
      workdir: transition.target.workdir,
      workdirState: {
        ...current.workdirState,
        epoch: Number(current.workdirState?.epoch || 0) + 1,
        committed: transition.target,
        seed: transition.transfer === 'reset' ? '' : current.workdirState?.seed,
        seedClaim: null,
        transition: { ...transition, phase: 'done' },
      },
      messages: withTransitionNote(current.messages, {
        from,
        to: transition.target.cwd,
        suffix,
        reset: transition.reset,
        operationId: transition.id,
      }),
    }));
  }

  /**
   * Исходная папка для плашки: подтверждённый снимок, иначе текущий выбор записи.
   * Пропавший каталог переходу не мешает — тогда плашка называет сохранённый выбор.
   */
  private async origin(record: StoredChat, current: ResolvedWorkdir | null): Promise<string> {
    if (current?.cwd) {
      return current.cwd;
    }

    try {
      return (await this.ports.resolve(record)).cwd;
    } catch {
      return chatWorkdirLabel(record.workdir);
    }
  }

  private async record(id: string): Promise<StoredChat> {
    const record = await this.ports.history.readOne(id);

    if (!record) {
      throw new ChatWorkdirError('unknown_chat', 'Чат не найден.', 404);
    }

    return record;
  }

  private async patch(id: string, update: (record: StoredChat) => Partial<StoredChat>): Promise<StoredChat> {
    const record = await this.ports.history.patchExecution(id, update);

    this.ports.notify(id);

    return record;
  }
}
