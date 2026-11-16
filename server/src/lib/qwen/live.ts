import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ExecutorRunInput, ExecutorRunResult } from '../executors/index.ts';
import type { ExternalCliProcessContext } from '../providerInstall/externalCliProcess.ts';
import {
  currentExternalCliProcess, withExternalCliProcess, withExternalCliLeaseJob,
} from '../providerInstall/externalCliProcess.ts';
import { settingsFingerprint } from '../executorSettings/fingerprint.ts';
import { validateWorkdirPath } from '../chat/workdir.ts';
import { createQwenBackground, type QwenBackgroundHooks } from './background.ts';
import { qwenPermissionResponse } from './permissions.ts';
import { qwenToolAllowed } from './policy.ts';
import { runQwenTurn } from './runtime.ts';
import { qwenConfig, readQwenSnapshot } from './settings.ts';
import { openQwenTransport, record } from './transport.ts';
import { resolveQwenWorkspace } from './workspace.ts';
import type { QwenOwnedProcess } from './sandbox.ts';

type Transport = Awaited<ReturnType<typeof openQwenTransport>>;
type Handlers = NonNullable<Parameters<typeof openQwenTransport>[3]>;
type Background = {
  source: string;
  nativeId?: string;
  abort: AbortController;
  collector: ReturnType<typeof createQwenBackground>;
  done: Promise<void>;
  resolve: () => void;
};
type LiveSpec = ExecutorRunInput & { hooks?: QwenBackgroundHooks };

// Тот же согласованный набор категорий, что ACTIVE_WORK_CATEGORIES шага 3 (решение 10);
// рассинхрон ловится handshake-проверкой шага 3 и parseActiveWork-тестами §6.2а.
const WORK_CATEGORIES = new Set(['agent', 'notification', 'shell', 'session', 'workflow', 'tool']);

type ActiveWork = {
  v: 1;
  seq: number;
  sessions: Array<{
    sessionId: string;
    holds: Array<{ category: string; id: string }>;
  }>;
};

/**
 * Проверяется весь снимок до изменения состояния, включая чужие записи.
 * Неизвестная категория или дубликат identity не превращаются в отсутствие работы.
 */
function parseActiveWork(value: unknown): ActiveWork | null {
  const snapshot = record(value);

  if (snapshot.v !== 1 || !Number.isSafeInteger(snapshot.seq) || Number(snapshot.seq) < 0
    || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > 1024) {
    return null;
  }

  const sessions = new Set<string>();

  for (const raw of snapshot.sessions) {
    const session = record(raw);

    if (typeof session.sessionId !== 'string' || !session.sessionId || sessions.has(session.sessionId)
      || !Array.isArray(session.holds) || session.holds.length > 1024
      || (session.hasRunningBackgroundTasks !== undefined
        && typeof session.hasRunningBackgroundTasks !== 'boolean')
      || (session.finishedBackgroundTurnId !== undefined
        && (typeof session.finishedBackgroundTurnId !== 'string' || !session.finishedBackgroundTurnId))) {
      return null;
    }

    sessions.add(session.sessionId);

    const holds = new Set<string>();

    for (const rawHold of session.holds) {
      const hold = record(rawHold);
      const key = JSON.stringify([hold.category, hold.id]);

      if (typeof hold.category !== 'string' || !WORK_CATEGORIES.has(hold.category)
        || typeof hold.id !== 'string' || !hold.id || holds.has(key)) {
        return null;
      }

      holds.add(key);
    }
  }

  return snapshot as ActiveWork;
}

/**
 * Старт cron/loop — единственный неоднозначный кадр окна загрузки:
 * историческая и живая запись различаются только последующим session hold.
 * Общий код всех этапов actor, не помечается как [replay-guard].
 */
function isCronLoopStart(method: string, value: unknown): boolean {
  const update = record(record(value).update);

  return method === 'session/update' && update.sessionUpdate === 'user_message_chunk'
    && ['cron', 'loop'].includes(String(record(update._meta).source));
}

/**
 * Набор транспортных картинок не перезапускает процесс и его фоновые задачи.
 * Изменение реальных корней, профиля доступа или документации переоткрывает handle.
 */
export async function qwenLiveFingerprint(spec: Record<string, unknown>): Promise<string> {
  const config = qwenConfig(spec.config);
  const workspace = await resolveQwenWorkspace(
    String(spec.cwd || config.rootDir || process.cwd()),
    Array.isArray(spec.extraDirs) ? spec.extraDirs.map(String) : [],
  );
  const attachment = typeof spec.attachmentsDir === 'string'
    ? await fs.realpath(spec.attachmentsDir).catch((error) => {
      if (error.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }) : undefined;
  const docs = Array.isArray(spec.pluginDocsDirs)
    ? await Promise.all(spec.pluginDocsDirs.map((directory) => validateWorkdirPath(String(directory)))) : [];

  return settingsFingerprint({
    cwd: workspace.cwd,
    extraDirs: workspace.extraDirs.filter((directory) => directory !== attachment),
    docs: [...new Set(docs)].sort(),
    model: spec.model || '',
    effort: spec.effort || '',
    permissionMode: spec.permissionMode || 'default',
    providerSettings: spec.providerSettings || {},
    workToolScopeKey: spec.workToolScopeKey || '',
    nativeSettingsFingerprint: spec.nativeSettingsFingerprint || '',
    auth: readQwenSnapshot(spec.config).fingerprint,
  });
}

/**
 * Живой handle удерживает native канал и контекст выбранной копии CLI между send.
 * Каждый foreground проходит прежний runQwenTurn; background имеет отдельный коллектор.
 */
class QwenLiveSession {
  private transport?: Transport;
  private opening?: Promise<Transport>;
  private ownedProcess?: QwenOwnedProcess;
  private setupFailed = false;
  // [replay-guard] окно session/load: что в нём пришло — история или живой фон
  private loading = false;
  private replayPending: {
    frames: Array<[string, unknown]>;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  // [replay-guard] принадлежность: после отложенного старта cron/loop его обычные
  // кадры — текст фона, а не история и не ответ пользователя; снимается при
  // session/prompt и при разрешении очереди
  private cronAttribution = false;
  // [replay-guard] наблюдённый жизненный цикл: session hold появлялся, пока очередь
  // cron ждала подтверждения; held→released внутри окна — завершённый настоящий цикл
  private replayHoldObserved = false;
  private handlers: Handlers | null = null;
  private background: Background | null = null;
  private foreground = false;
  private deferredNotifications: Array<[string, unknown]> = [];
  private closed = false;
  private closeJob?: Promise<void>;
  private currentAbort?: AbortController;
  private processAbort = new AbortController();
  private pendingPrompt: Promise<unknown> | null = null;
  private sessionId: string;
  private mode: string;
  private heartbeatSeq = -1;
  private latest: ExecutorRunInput;
  private latestSessionHeld = false;
  private cronHeld = false;
  private goalEnds = new Set<string>();
  private cancelDeadline?: ReturnType<typeof setTimeout>;
  private hooks: QwenBackgroundHooks;
  private context: ExternalCliProcessContext;
  private spec: LiveSpec;

  constructor(spec: LiveSpec, context: ExternalCliProcessContext) {
    this.spec = spec;
    this.context = context;
    this.latest = spec;
    this.sessionId = spec.sessionId || '';
    this.mode = spec.permissionMode || 'default';
    this.hooks = spec.hooks || {};
  }

  get alive(): boolean {
    return !this.closed && !this.setupFailed && (!this.transport || !this.transport.client.closed);
  }

  get pid(): number | null {
    return this.transport?.child.pid || this.ownedProcess?.child.pid || null;
  }

  /**
   * Admission фона не вытесняет уже начатый пользовательский prompt.
   * Публикация остаётся под контролем общего ChatBackgroundRuns через hooks.
   */
  private begin(source: string, nativeId?: string): void {
    if (this.closed || this.background || this.foreground) {
      return;
    }

    let resolve!: () => void;
    const done = new Promise<void>((settled) => {
      resolve = settled;
    });

    this.cronHeld = source === 'cron' && this.latestSessionHeld;
    this.background = {
      source,
      nativeId,
      abort: new AbortController(),
      collector: createQwenBackground(this.sessionId, this.hooks),
      done,
      resolve,
    };
    this.hooks.onBackgroundStart?.();
  }

  /**
   * Завершение отсоединяет коллектор до async-публикации, чтобы дубликат не создал второй итог.
   * Ожидающий send освобождается только после передачи результата общему владельцу.
   */
  private async end(reason: string): Promise<void> {
    const current = this.background;

    if (!current) {
      return;
    }

    this.background = null;
    clearTimeout(this.cancelDeadline);
    this.cancelDeadline = undefined;

    try {
      await current.collector.finish(current.abort.signal.aborted ? 'cancelled' : reason);
    } finally {
      current.resolve();
    }
  }

  /**
   * Heartbeat — полный versioned снимок, старый seq и чужая сессия не снимают holds.
   * Cron заканчивается лишь после native session hold release; idle-пауза не используется.
   */
  private async heartbeat(value: unknown): Promise<void> {
    const snapshot = parseActiveWork(value);

    if (!snapshot) {
      const note = {
        k: 'note',
        level: 'warn',
        text: 'Qwen: повреждён active-work heartbeat.',
      };

      this.hooks.onBackgroundStep?.(note);

      return;
    }

    if (snapshot.seq <= this.heartbeatSeq) {
      return;
    }

    const session = snapshot.sessions.find((entry) => entry.sessionId === this.sessionId);

    if (!session) {
      return;
    }

    this.heartbeatSeq = snapshot.seq;
    this.latestSessionHeld = session.holds.some((hold) => hold.category === 'session');

    // [replay-guard] свежий hold подтверждает отложенную очередь окна загрузки;
    // hold наблюдённый пока очередь ждёт запоминает жизненный цикл для finally
    if (this.latestSessionHeld) {
      if (this.hasPendingCron()) {
        this.replayHoldObserved = true;
      }

      this.releaseReplayPending();
    }

    const tasks = session.holds.filter((hold) => hold.category !== 'session').map((hold) => ({
      id: hold.id,
      kind: hold.category === 'agent' ? 'subagent' as const
        : hold.category === 'shell' ? 'command' as const : 'other' as const,
      description: 'Фоновая задача Qwen',
    }));

    this.hooks.onBackgroundTasks?.(tasks);

    if (this.background?.source === 'cron') {
      this.cronHeld ||= this.latestSessionHeld;

      if (this.cronHeld && !this.latestSessionHeld) {
        await this.end('end_turn');
      }
    }
  }

  /**
   * [replay-guard] Очередь окна загрузки публикуется только после живого session hold.
   * Без hold она отбрасывается по таймеру: старт cron в истории не имел активной работы.
   */
  private releaseReplayPending(): void {
    const pending = this.replayPending;

    if (!pending) {
      return;
    }

    this.replayPending = null;
    this.cronAttribution = false;
    this.replayHoldObserved = false;
    clearTimeout(pending.timer);

    void (async () => {
      for (const [method, value] of pending.frames) {
        await this.notify(method, value);
      }
    })().catch(() => {
      this.hooks.onBackgroundStep?.({
        k: 'note',
        level: 'warn',
        text: 'Qwen: подтверждение фона после загрузки не завершено.',
      });
    });
  }

  /**
   * [replay-guard] Отложенный старт cron/loop открывает принадлежность его обычных
   * кадров; уже наблюдённый session hold сразу засчитывается как жизненный цикл.
   */
  private deferCronStart(cronStart: boolean): void {
    if (!cronStart) {
      return;
    }

    this.cronAttribution = true;

    if (this.latestSessionHeld) {
      this.replayHoldObserved = true;
    }
  }

  /**
   * [replay-guard] Очередь cron ждёт подтверждения в окне загрузки/foreground
   * или в буфере replayPending; только её касаются наблюдения жизненного цикла.
   */
  private hasPendingCron(): boolean {
    return this.replayPending !== null
      || this.deferredNotifications.some(([method, value]) => isCronLoopStart(method, value));
  }

  /**
   * Модель и режим обновляются независимо от владельца foreground/background.
   * Replay загрузки не создаёт фон, а source cron/loop открывает самостоятельный цикл;
   * настоящий cron не несёт backgroundTurn, поэтому после его старта обычные кадры
   * окна откладываются по принадлежности, а не в ответ пользователя.
   */
  private async notify(method: string, value: unknown): Promise<void> {
    const deferredParams = record(value);
    const deferredUpdate = record(deferredParams.update);
    const cronStart = isCronLoopStart(method, value);
    const startsAutonomous = method === '_qwencode/start_turn' || cronStart;
    const backgroundTurn = method === 'session/update'
      && typeof record(record(deferredUpdate._meta).backgroundTurn).turnId === 'string';
    const attributed = this.cronAttribution && method === 'session/update';

    // [replay-guard] этап 3: история окна загрузки молчит, живые старты откладываются
    if (this.loading) {
      if (startsAutonomous || backgroundTurn || attributed
        || (method === '_qwencode/end_turn' && this.background)) {
        this.deferCronStart(cronStart);
        this.deferredNotifications.push([method, value]);

        return;
      }

      if (method === 'session/update' || method === '_qwencode/start_turn'
        || method === '_qwencode/end_turn') {
        return;
      }
    }

    // [replay-guard] в подтверждении копятся только фоновые кадры; текст ответа
    // пользователя идёт дальше по конвейеру и не глотается
    if (this.replayPending && (startsAutonomous || backgroundTurn || attributed
      || (method === '_qwencode/end_turn' && this.background))) {
      this.deferCronStart(cronStart);
      this.replayPending.frames.push([method, value]);

      return;
    }

    if (this.foreground && (startsAutonomous || backgroundTurn || attributed)) {
      this.deferCronStart(cronStart);
      this.deferredNotifications.push([method, value]);

      return;
    }

    if (method === 'qwen/notify/channel/active-work') {
      await this.heartbeat(value);

      return;
    }

    const params = record(value);

    if (this.closed || params.sessionId !== this.sessionId) {
      return;
    }

    if (method === 'qwen/notify/session/mode-update' && typeof params.currentModeId === 'string') {
      this.mode = params.currentModeId;
    }

    if (method === '_qwencode/start_turn') {
      this.begin(String(params.source || 'goal'), String(params.turnId || '') || undefined);

      return;
    }

    if (method === '_qwencode/end_turn') {
      const current = this.background;
      const source = String(params.source || 'goal');
      const promptId = typeof params.promptId === 'string' ? params.promptId : '';
      const matching = current?.nativeId
        ? params.turnId === current.nativeId
        : source === 'goal' && promptId.startsWith(this.sessionId + '########')
          && !this.goalEnds.has(promptId);

      if (current && current.source !== 'cron' && source === current.source && matching) {
        if (source === 'goal') {
          this.goalEnds.add(promptId);
        }

        await this.end(String(params.reason || 'end_turn'));
      }

      return;
    }

    if (method === 'session/update') {
      const update = record(params.update);
      const meta = record(update._meta);

      if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
        this.mode = update.currentModeId;
      }

      if (update.sessionUpdate === 'user_message_chunk' && ['cron', 'loop'].includes(String(meta.source))) {
        this.begin('cron');
      }

      if (this.background) {
        const turn = record(meta.backgroundTurn).turnId;

        if (!turn || !this.background.nativeId || turn === this.background.nativeId) {
          this.background.collector.observe(update);
        }

        return;
      }
    }

    await this.handlers?.onNotification?.(method, value);
  }

  /**
   * Host guard вызывается и из native-детей без top-level promptId.
   * Привязка к сессии и собственному каналу обязательна даже вне foreground.
   */
  private async reverse(method: string, value: unknown): Promise<unknown> {
    const params = record(value);

    if (method === 'qwen/control/external_tool_guard/prepare') {
      const signal = this.foreground ? this.currentAbort?.signal : this.background?.abort.signal;
      const allowed = !this.closed && await qwenToolAllowed(value, {
        hostAccess: true,
        sessionId: this.sessionId,
        promptId: '',
        cwd: String(this.spec.cwd || ''),
        writableRoots: [],
        readonlyRoots: [],
        mode: this.mode,
        mcpServers: [],
        blockDirectSsh: record(this.spec.providerSettings).blockDirectSsh !== false,
        signal: signal || this.processAbort.signal,
      });

      return { allowed };
    }

    if (method === '_qwencode/start_turn') {
      if (this.closed || params.sessionId !== this.sessionId || this.foreground || this.background) {
        return { accepted: false };
      }

      this.begin(
        String(params.source || 'background_notification'),
        String(params.turnId || '') || undefined,
      );

      return { accepted: true };
    }

    if (this.background && method === 'session/request_permission' && params.sessionId === this.sessionId) {
      const ask = typeof this.latest.onPermission === 'function'
        ? this.latest.onPermission as (question: Record<string, unknown>) => Promise<unknown> : undefined;

      return qwenPermissionResponse(value, {
        ask,
        signal: this.background.abort.signal,
        factory: false,
      });
    }

    if (this.handlers?.onReverseRequest) {
      return this.handlers.onReverseRequest(method, value);
    }

    throw new Error('Qwen: неизвестный reverse RPC вне хода');
  }

  /**
   * Foreground получает новый набор callbacks, но тот же reader и native процесс.
   * Неответивший отменённый prompt делает канал непригодным для следующего send.
   */
  private attach: typeof openQwenTransport = async (config, snapshot, options, handlers = {}) => {
    this.handlers = handlers;

    if (this.closed || this.setupFailed) {
      throw new Error('Qwen: незавершённая подготовка требует подтверждённого закрытия');
    }

    if (!this.transport) {
      const opening = Promise.resolve().then(() => openQwenTransport(config, snapshot, {
        ...options,
        onOwnedProcess: (resource) => {
          this.ownedProcess = resource;
        },
      }, {
        onNotification: (method, value) => this.notify(method, value),
        onReverseRequest: (method, value) => this.reverse(method, value),
      }));

      this.opening = opening;

      try {
        const opened = await opening;

        if (this.closed) {
          await opened.close();

          throw new Error('Qwen: открытие отменено закрытием живой сессии');
        }

        this.transport = opened;
        opened.child.once('close', () => {
          void this.close().catch(() => this.reportCloseFailure());
        });
      } catch (error) {
        this.setupFailed = true;

        throw error;
      } finally {
        if (this.opening === opening) {
          this.opening = undefined;
        }
      }
    }

    const native = this.transport;
    const client = {
      ...native.client,
      request: (method: string, params?: unknown, timeoutMs?: number) => {
        // [replay-guard] окно загрузки закрывается фактическим ответом session/load
        const loading = method === 'session/load' || method === 'session/resume';

        if (loading) {
          this.loading = true;
        }

        const request = native.client.request(method, params, timeoutMs);

        if (loading) {
          void request.then(() => {
            this.loading = false;
          }, () => {
            this.loading = false;
          });
        }

        if (method === 'session/prompt') {
          // [replay-guard] native занят пользовательским ходом: принадлежность
          // отложенного cron не должна глотать текст ответа пользователя
          this.cronAttribution = false;
          this.pendingPrompt = request;
          void request.then(() => {
            this.pendingPrompt = null;
          }, () => {
            this.pendingPrompt = null;
          });
        }

        return request;
      },
    };

    return {
      ...native,
      client,
      close: async () => {
        this.handlers = null;

        if (this.pendingPrompt) {
          await this.close();
        }
      },
    };
  };

  /**
   * Фон и новый пользовательский ход не смешивают накопители или отмену.
   * Контекст external CLI восстанавливается явно: open уже закончил свой async scope.
   */
  async send(turn: Partial<ExecutorRunInput>): Promise<ExecutorRunResult> {
    if (this.setupFailed) {
      throw new Error('Qwen: незавершённая подготовка требует подтверждённого закрытия');
    }

    if (!this.alive) {
      throw new Error('Qwen: живая сессия закрыта');
    }

    if (this.background) {
      await this.waitBackground(this.background.done, turn.signal);
    }

    if (turn.signal?.aborted) {
      throw Object.assign(new Error('Ход остановлен.'), {
        stopped: true,
        steps: [],
        sessionId: this.sessionId,
      });
    }

    if (!this.alive) {
      throw new Error('Qwen: живая сессия завершилась во время ожидания фона');
    }

    this.foreground = true;
    this.currentAbort = new AbortController();

    const signal = turn.signal
      ? AbortSignal.any([turn.signal, this.currentAbort.signal, this.processAbort.signal])
      : AbortSignal.any([this.currentAbort.signal, this.processAbort.signal]);
    const onSessionCreated = turn.onSessionCreated || this.spec.onSessionCreated;
    const input: ExecutorRunInput = {
      ...this.spec,
      ...turn,
      config: this.spec.config,
      cwd: this.spec.cwd,
      extraDirs: this.spec.extraDirs,
      providerSettings: this.spec.providerSettings,
      env: this.spec.env,
      signal,
      sessionId: this.sessionId || this.spec.sessionId,
      attachmentPaths: turn.attachmentPaths || [],
      onSessionCreated: async (id) => {
        this.sessionId = id;
        await onSessionCreated?.(id);
      },
    };

    this.latest = input;

    try {
      return await withExternalCliLeaseJob(String(this.spec.chatKey || ''), () => {
        return withExternalCliProcess(this.context,
          () => runQwenTurn(input, { openTransport: this.attach }));
      });
    } finally {
      this.handlers = null;
      this.foreground = false;

      // Отложенная очередь воспроизводится после хода; очередь cron без наблюдённого
      // жизненного цикла ждёт подтверждения heartbeat, иначе умирает как история.
      const deferred = this.deferredNotifications.splice(0);
      const cronQueued = deferred.some(([method, value]) => isCronLoopStart(method, value));
      // [replay-guard] наблюдённый held→released подтверждает завершённый цикл:
      // текущий latestSessionHeld=false без этого следа не отличает его от истории
      const awaitsHold = cronQueued && !this.latestSessionHeld && !this.replayHoldObserved;

      if (awaitsHold) {
        clearTimeout(this.replayPending?.timer);
        this.replayPending = {
          frames: deferred,
          timer: setTimeout(() => {
            this.replayPending = null;
            this.cronAttribution = false;
            this.replayHoldObserved = false;
          }, 11000),
        };
        this.replayPending.timer.unref?.();
      } else {
        for (const [method, value] of deferred) {
          await this.notify(method, value);
        }

        // [replay-guard] цикл подтверждён и уже отпущен native до конца хода:
        // публикуем завершённым, нового release не будет
        if (cronQueued && this.replayHoldObserved && !this.latestSessionHeld) {
          await this.end('end_turn');
        }

        this.cronAttribution = false;
        this.replayHoldObserved = false;
      }

      this.currentAbort = undefined;
    }
  }

  /**
   * Stop прерывает работу текущего scope; исправный канал остаётся для следующего сообщения.
   * Native end-turn или общий backstop пула завершают остановленный фон.
   */
  async interrupt(): Promise<void> {
    this.currentAbort?.abort();
    this.background?.abort.abort();

    if (this.transport && !this.transport.client.closed && this.sessionId) {
      this.transport.client.notify('session/cancel', { sessionId: this.sessionId });
    }

    if (this.background && !this.cancelDeadline) {
      this.cancelDeadline = setTimeout(() => {
        void this.end('cancelled').finally(() => this.close())
          .catch(() => this.reportCloseFailure());
      }, 1000);
      this.cancelDeadline.unref?.();
    }
  }

  /**
   * Отмена ожидающего foreground освобождает HTTP-ход даже при неответившем фоне.
   * Подписка снимается и при обычном завершении, и при закрытии своего процесса.
   */
  private waitBackground(done: Promise<void>, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        signal?.removeEventListener('abort', wake);
        this.processAbort.signal.removeEventListener('abort', wake);
        resolve();
      };

      signal?.addEventListener('abort', wake, { once: true });
      this.processAbort.signal.addEventListener('abort', wake, { once: true });
      void done.then(wake, wake);

      if (signal?.aborted || this.processAbort.signal.aborted) {
        wake();
      }
    });
  }

  /**
   * Асинхронный exit не создаёт unhandled rejection при отказе OS cleanup.
   * Неизвестный scope остаётся занятой записью пула до подтверждённого закрытия.
   */
  private reportCloseFailure(): void {
    const log = record(this.spec.log);

    if (typeof log.warn === 'function') {
      log.warn({ code: 'qwen_host_scope_close_failed' }, 'Qwen: process scope не подтвердил завершение');
    }
  }

  /**
   * Закрытие идемпотентно; callbacks старого поколения не могут вернуть процесс в пул.
   * Сначала отзывается доступ и завершается reader, затем снимаются собственные ресурсы.
   */
  close(): Promise<void> {
    if (this.closeJob) {
      return this.closeJob;
    }

    this.closed = true;
    this.processAbort.abort();
    this.currentAbort?.abort();
    this.background?.abort.abort();
    clearTimeout(this.cancelDeadline);
    // [replay-guard] неопознанная очередь окна загрузки не переживает закрытие
    clearTimeout(this.replayPending?.timer);
    this.replayPending = null;
    this.cronAttribution = false;
    this.replayHoldObserved = false;

    const abandoned = this.background;

    this.background = null;
    abandoned?.resolve();

    const opening = this.opening;

    this.closeJob = (async () => {
      await opening?.catch(() => undefined);
      await this.transport?.close();
      await this.ownedProcess?.close();
      this.ownedProcess = undefined;
      this.hooks.onBackgroundTasks?.([]);
      this.hooks.onExit?.({ reason: 'процесс Qwen завершён' });
    })().catch((error) => {
      this.closeJob = undefined;

      throw error;
    });

    return this.closeJob;
  }
}

/**
 * Открытие handle захватывает только доверенную среду, подготовленную externalCliAdapter.
 * Ни текст сообщения, ни аргументы инструмента не выбирают чужой executable или lease.
 */
export async function openQwenLiveSession(spec: LiveSpec) {
  const context = currentExternalCliProcess();

  if (!context) {
    throw new Error('Qwen: не подготовлена выбранная копия CLI');
  }

  return new QwenLiveSession(spec, context);
}
