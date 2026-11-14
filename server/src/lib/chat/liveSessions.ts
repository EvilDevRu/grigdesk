// Пул живых сессий исполнителей: процесс агента переживает свой ход.
//
// Раньше GrigDesk поднимал CLI на КАЖДОЕ сообщение и убивал вместе с ответом. Поэтому
// всё, что агент оставлял после себя, умирало тоже: фоновые команды, субагенты и любое
// ожидание. Здесь процесс живёт до простоя, смены модели или остановки сервера, а ход
// становится отрезком его потока.
//
// Модуль provider-neutral: он не знает ни claude, ни codex. Умеет ли исполнитель жить
// между ходами, объявляет он сам полем `session` своего контракта; пул только владеет
// временем жизни, потолком и доставкой непрошеных ходов.

import { randomUUID } from 'node:crypto';

import type { ProviderUsagePatch } from '../providerUsage.ts';
import type { BackgroundIdentity, BackgroundSession } from './backgroundRuns.ts';
import type { ChatBackgroundTask } from '../../../../shared/chat/chatBackgroundTasks.ts';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 4;
// Что нельзя поменять на лету: это флаги командной строки, зафиксированные при запуске
// процесса. Исполнитель вправе назвать свой набор — тогда сессия переоткроется только
// на его полях.
const DEFAULT_RESTART_ON = [
  'model', 'effort', 'permissionMode', 'cwd', 'extraDirs', 'workToolScopeKey',
];

// Ход через живую сессию: что просит вызывающий и чем это исполняется.
export interface LiveSessionSpec {
  chatKey?: unknown;
  executor?: LiveExecutor;
  sessionId?: string | null;
  model?: string;
  effort?: string;
  permissionMode?: string;
  modeSelection?: import('../../../../shared/chat/chatPermissionModes.ts').ChatModeSelection;
  preparedRuntime?: object;
  runtimeProfileFingerprint?: string;
  cwd?: string;
  extraDirs?: string[];
  signal?: AbortSignal;
  sessionIdAuthoritative?: boolean;
  onProviderUsage?: (patch: ProviderUsagePatch) => boolean;
  [field: string]: unknown;
}

// Живой процесс исполнителя: пул владеет только его временем жизни.
export interface LiveHandle {
  prepareTransition?: (next: LiveSessionSpec) => Promise<void>;
  pid?: number | null;
  alive: boolean;
  send: (turn: unknown) => Promise<{ sessionId?: string } | null>;
  interrupt: () => Promise<unknown>;
  close: () => Promise<unknown>;
}

// Контракт исполнителя в части жизни между ходами; объявляет его он сам.
export interface LiveExecutor {
  id?: string;
  session?: {
    open?: (spec: Record<string, unknown>) => Promise<LiveHandle>;
    restartOn?: string[];
    unsolicited?: boolean;
    mode?: 'persistent' | 'per-turn';
    enabled?: (spec: LiveSessionSpec) => boolean;
    fingerprint?: (spec: LiveSessionSpec) => Promise<string> | string;
    keepAlive?: boolean;
  };
}

/**
 * Адаптер сам выбирает применимость своей живой сессии для текущего профиля.
 * Исполнители без предиката сохраняют прежний допуск persistent.
 */
export function liveSessionEnabled(executor: LiveExecutor | undefined, spec: LiveSessionSpec): boolean {
  return executor?.session?.mode === 'persistent' && !!executor.session.open
    && (!executor.session.enabled || executor.session.enabled(spec) === true);
}

// Запись пула: процесс плюс копия параметров запуска, зафиксированных на его жизнь.
interface LiveEntry {
  chatKey: string;
  executorId: string;
  unsolicited: boolean;
  keepAlive: boolean;
  fingerprint: string;
  sessionId: string | null;
  model: string;
  effort: string;
  permissionMode: string;
  cwd: string;
  extraDirs: string[];
  sessionToken: string;
  managed: boolean;
  background: { backgroundId: string } | null;
  backgroundTasks: ChatBackgroundTask[];
  closedNotified: boolean;
  backgroundWaiters: Array<() => void>;
  openedAt: number;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  handle: LiveHandle;
}

// Событие состава пула для окон: сессия открылась или закрылась.
export interface LiveSessionsEvent {
  chatKey: string;
  event: 'opened' | 'closed' | 'busy' | 'tasks';
  reason?: string;
}

// Журнал сервера в том минимуме, который пул использует.
interface LiveLog {
  info?: (fields: Record<string, unknown>, message: string) => void;
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Сон обещает самостоятельное пробуждение только живого процесса между ходами.
 * Занятость ходом сохраняет прежний контракт busy и не подменяется ожиданием задач.
 */
function sleeping(entry: LiveEntry): boolean {
  return !!entry.handle?.alive && entry.unsolicited && entry.backgroundTasks.length > 0
    && !entry.managed && !entry.background;
}

function fingerprintOf(spec: LiveSessionSpec, fields: readonly string[]): string {
  const parts: Record<string, unknown> = {};
  for (const field of fields) {
    const value = spec[field];
    parts[field] = Array.isArray(value) ? [...value].sort() : (value ?? null);
  }
  return JSON.stringify(parts);
}

interface BackgroundStartEvent {
  chatKey: string;
  identity: BackgroundIdentity;
  session: BackgroundSession;
}

export class ChatLiveSessions {
  readonly maxSessions: number;

  readonly idleMs: number;

  readonly log: LiveLog | null;

  private onBackgroundStart: ((event: BackgroundStartEvent) => void) | null;

  private onBackgroundTurn:
  ((event: {
    chatKey: string;
    executorId: string;
    result: unknown;
    identity: BackgroundIdentity;
  }) => void) | null;

  private onBackgroundStep: ((event: {
    chatKey: string;
    step: unknown;
    identity: BackgroundIdentity;
  }) => void) | null;

  private onBackgroundProgress:
  ((event: {
    chatKey: string;
    tokens: unknown;
    extra: unknown;
    identity: BackgroundIdentity;
  }) => void) | null;

  private onSessionClosed: ((event: {
    chatKey: string;
    reason: string;
    sessionToken: string;
  }) => void) | null;

  private onChange: ((event: LiveSessionsEvent) => void) | null;

  private entries: Map<string, LiveEntry>;

  private closed: boolean;

  // Закрытие процесса по чату ещё идёт: новый CLI на ту же сессию поднимать нельзя,
  // второй процесс с тем же sessionId падает сразу.
  private closing: Map<string, Promise<void>>;

  private opening = 0;
  private admission: Promise<void> = Promise.resolve();

  constructor({
    maxSessions = DEFAULT_MAX_SESSIONS,
    idleMs = DEFAULT_IDLE_MS,
    log = null,
    onBackgroundStart = null,
    onBackgroundTurn = null,
    onBackgroundStep = null,
    onBackgroundProgress = null,
    onSessionClosed = null,
    onChange = null,
  }: {
    maxSessions?: number;
    idleMs?: number;
    log?: LiveLog | null;
    onBackgroundStart?: ((event: BackgroundStartEvent) => void) | null;
    onBackgroundTurn?: ((event: {
      chatKey: string;
      executorId: string;
      result: unknown;
      identity: BackgroundIdentity;
    }) => void) | null;
    onBackgroundStep?: ((event: {
      chatKey: string;
      step: unknown;
      identity: BackgroundIdentity;
    }) => void) | null;
    onBackgroundProgress?: ((event: {
      chatKey: string;
      tokens: unknown;
      extra: unknown;
      identity: BackgroundIdentity;
    }) => void) | null;
    onSessionClosed?: ((event: {
      chatKey: string;
      reason: string;
      sessionToken: string;
    }) => void) | null;
    onChange?: ((event: LiveSessionsEvent) => void) | null;
  } = {}) {
    this.maxSessions = Math.max(1, Number(maxSessions) || DEFAULT_MAX_SESSIONS);
    this.idleMs = Math.max(60_000, Number(idleMs) || DEFAULT_IDLE_MS);
    this.log = log;
    this.onBackgroundStart = onBackgroundStart;
    this.onBackgroundTurn = onBackgroundTurn;
    this.onBackgroundStep = onBackgroundStep;
    this.onBackgroundProgress = onBackgroundProgress;
    this.onSessionClosed = onSessionClosed;
    // Состав пула меняется редко (открытие, простой, вытеснение, смерть процесса),
    // поэтому о нём можно честно оповещать окна, а не заставлять их опрашивать список.
    this.onChange = onChange;
    this.entries = new Map();
    this.closed = false;
    this.closing = new Map();
  }

  /**
   * Ход через живую сессию: берём подходящую, иначе открываем. Возвращает то же, что
   * разовый `executor.run`, поэтому вызывающий код о смене модели работы не знает.
   */
  async run(spec: LiveSessionSpec, turn: unknown): Promise<{ sessionId?: string } | null> {
    const entry = await this._acquire(spec);

    if (spec.signal?.aborted) {
      throw Object.assign(new Error('Ход остановлен.'), {
        stopped: true,
        steps: [],
        sessionId: entry.sessionId,
      });
    }

    const wasSleeping = sleeping(entry);

    entry.managed = true;
    this._clearIdle(entry);

    if (wasSleeping) {
      this.onChange?.({ chatKey: entry.chatKey, event: 'tasks' });
    }

    // Id сессии пул узнаёт с первого события хода, а не по его итогу: по нему сессия
    // переоткроется после смерти процесса, даже если ход до result не дожил.
    const turnSpec = turn && typeof turn === 'object'
      ? turn as { onSessionCreated?: (sessionId: string) => unknown }
      : null;
    const send = turnSpec
      ? {
        ...turnSpec,
        onSessionCreated: (sessionId: string) => {
          if (sessionId) entry.sessionId = sessionId;
          return turnSpec.onSessionCreated?.(sessionId);
        },
      }
      : turn;
    try {
      const result = await entry.handle.send(send);
      // sessionId нужен и живой сессии: по нему она переоткроется после простоя,
      // рестарта сервера или смены модели.
      if (result?.sessionId) entry.sessionId = result.sessionId;
      return result;
    } finally {
      entry.managed = false;
      entry.lastUsed = Date.now();

      if (!entry.background && this.entries.get(entry.chatKey) === entry) {
        this._armIdle(entry);

        if (sleeping(entry)) {
          this.onChange?.({ chatKey: entry.chatKey, event: 'tasks' });
        }
      }
    }
  }

  /** «Стоп» человека: прерываем ход, сессию и её память сохраняем. */
  async interrupt(chatKey: unknown): Promise<boolean> {
    const entry = this.entries.get(String(chatKey || ''));
    if (!entry?.handle?.alive) return false;
    await entry.handle.interrupt();
    return true;
  }

  has(chatKey: unknown): boolean {
    const entry = this.entries.get(String(chatKey || ''));

    return !!entry && (entry.keepAlive || !!entry.handle?.alive);
  }

  /**
   * Закрытие keepAlive-процесса сначала подтверждает завершение scope и только потом
   * убирает запись: неизвестный исход оставляет слот занятым до повторного close.
   */
  async close(chatKey: unknown, reason = 'закрыта'): Promise<boolean> {
    const entry = this.entries.get(String(chatKey || ''));

    if (!entry) {
      return false;
    }

    if (entry.keepAlive) {
      await this._closeHandle(entry);
      this._forget(entry, reason);
    } else {
      this._forget(entry, reason);
      await this._closeHandle(entry);
    }

    return true;
  }

  /**
   * Закрывает все поколения пула и будит ожидающие фон ходы.
   * Уведомление о каждой entry отправляется до ожидания закрытия транспорта.
   */
  async closeAll(reason = 'остановка сервера'): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();

    for (const entry of entries) {
      this._clearIdle(entry);
      this._notifyClosed(entry, reason);
    }

    await Promise.all(entries.map((entry) => entry.handle.close().catch((error) => {
      this.log?.warn?.({ err: (error as Error).message }, 'чат: process scope не подтвердил завершение');
    })));
    if (entries.length) {
      this.log?.info?.({ count: entries.length, reason }, 'чат: живые сессии закрыты');
      this.onChange?.({ chatKey: '', event: 'closed', reason });
    }
  }

  /**
   * Что за процессы сейчас живут. Отдаём то, чем человек отличает одну сессию от
   * другой и по чему сверяет её с `ps`: pid, исполнителя, параметры запуска и время
   * до автоматического гашения. Секретов здесь нет — env и аргументы наружу не идут.
   */
  stats() {
    const now = Date.now();
    return [...this.entries.values()].map((entry) => ({
      chatKey: entry.chatKey,
      executor: entry.executorId,
      pid: entry.handle?.pid ?? null,
      alive: !!entry.handle?.alive,
      busy: !!entry.managed || !!entry.background,
      unsolicited: !!entry.unsolicited,
      sleeping: sleeping(entry),
      backgroundTasks: entry.backgroundTasks.map((task) => ({ ...task })),
      sessionId: entry.sessionId || null,
      model: entry.model || '',
      effort: entry.effort || '',
      permissionMode: entry.permissionMode || '',
      cwd: entry.cwd || '',
      extraDirs: entry.extraDirs || [],
      openedAt: entry.openedAt,
      lastUsed: entry.lastUsed,
      // Занятая сессия по простою не гаснет: таймер перевзводится, пока идёт ход.
      // keepAlive-процесс живёт без idle timer до явного закрытия владельцем.
      idleAtMs: (entry.managed || entry.background || sleeping(entry) || entry.keepAlive)
        ? null : Math.max(now, entry.lastUsed + this.idleMs),
    }));
  }

  /** Границы пула — чтобы окно объясняло их словами, а не повторяло числа у себя. */
  limits() {
    return { maxSessions: this.maxSessions, idleMs: this.idleMs, live: this.entries.size };
  }

  async _acquire(spec: LiveSessionSpec): Promise<LiveEntry> {
    const chatKey = String(spec.chatKey || '');
    if (!chatKey) throw new Error('Живая сессия требует ключ чата.');
    if (this.closed) throw new Error('Сервер останавливается — новая сессия не открывается.');

    const executor = spec.executor;
    const session = executor?.session;

    if (!session?.open || !liveSessionEnabled(executor, spec)) {
      throw new Error('Исполнитель отключил живую сессию для этого профиля.');
    }

    const fields = Array.isArray(session.restartOn) && session.restartOn.length
      ? session.restartOn
      : DEFAULT_RESTART_ON;
    const fingerprint = session.fingerprint
      ? await session.fingerprint(spec) : fingerprintOf(spec, fields);

    let existing = this.entries.get(chatKey);

    while (existing?.handle.alive && existing.background && !this.closed && !spec.signal?.aborted) {
      await this._waitBackground(existing, spec.signal);
      existing = this.entries.get(chatKey);
    }

    if (this.closed) {
      throw new Error('Сервер останавливается — новая сессия не открывается.');
    }
    if (spec.signal?.aborted) {
      throw Object.assign(new Error('Ход остановлен.'), {
        stopped: true,
        steps: [],
        sessionId: existing?.sessionId,
      });
    }
    if (existing) {
      // Присланный клиентом id сессии сравниваем, только когда он НЕПУСТ: пустой значит
      // «окно ещё не знает id», а не «начни заново». Осознанный сброс памяти закрывает
      // сессию отдельным вызовом close() — иначе отставшее окно рвало бы живой разговор.
      const foreignSession = !!spec.sessionId
        && !!existing.sessionId
        && spec.sessionId !== existing.sessionId;
      const sameExecutor = existing.executorId === String(executor?.id ?? '');
      const authoritativeReset = spec.sessionIdAuthoritative === true
        && !spec.sessionId && !!existing.sessionId;
      const reusable = existing.handle.alive
        && existing.fingerprint === fingerprint
        && sameExecutor
        && !foreignSession
        && !authoritativeReset;
      if (reusable) return existing;

      // Сессия умерла сама либо изменилось то, что задаётся при запуске процесса.
      // Разговор при этом не теряется: новый процесс поднимается с прежним sessionId.
      // Но только у ТОГО ЖЕ исполнителя: id сессии принадлежит вендору, и thread claude
      // для codex (как и наоборот) — чужой id, resume по нему падает «no rollout found».
      // После смены ИИ новый процесс стартует с чистой памятью, как и обещает окно.
      let reason = 'изменились параметры запуска';
      if (!existing.handle.alive) {
        reason = 'процесс завершился';
      } else if (!sameExecutor) {
        reason = 'сменился исполнитель';
      } else if (foreignSession) {
        reason = 'сменился id сессии';
      }

      await existing.handle.prepareTransition?.(spec);

      const inherited = sameExecutor ? existing.sessionId : null;

      spec = {
        ...spec,
        sessionId: spec.sessionIdAuthoritative === true ? spec.sessionId : spec.sessionId || inherited,
      };

      if (existing.keepAlive) {
        await this._closeHandle(existing);
        this._forget(existing, reason);
      } else {
        this._forget(existing, reason);
        await this._closeHandle(existing);
      }
    }

    // Процесс этого чата мог закрываться другим путём (стоп фона, простой): ждём его конца.
    while (this.closing.has(chatKey)) {
      await this.closing.get(chatKey);
    }

    if (this.closed) {
      throw new Error('Сервер останавливается — новая сессия не открывается.');
    }

    const releaseOpening = await this.reserveOpening(session.keepAlive === true);

    try {
      const entry: LiveEntry = {
        chatKey,
        executorId: String(executor?.id ?? ''),
        unsolicited: !!session.unsolicited,
        keepAlive: session.keepAlive === true,
        fingerprint,
        sessionId: spec.sessionId || null,
        // Копия параметров запуска: они зафиксированы на жизнь процесса, и человек по
        // ним понимает, почему сессия переоткрылась и чем этот процесс отличается от
        // выбранного сейчас в чате.
        model: spec.model || '',
        effort: spec.effort || '',
        permissionMode: spec.permissionMode || '',
        cwd: spec.cwd || '',
        extraDirs: Array.isArray(spec.extraDirs) ? [...spec.extraDirs] : [],
        sessionToken: `live-${randomUUID()}`,
        managed: false,
        background: null,
        backgroundTasks: [],
        closedNotified: false,
        backgroundWaiters: [],
        openedAt: Date.now(),
        lastUsed: Date.now(),
        idleTimer: null,
        handle: null as unknown as LiveHandle,
      };

      entry.handle = await session.open({
        ...spec,
        log: this.log,
        hooks: {
          onBackgroundTasks: (tasks: ChatBackgroundTask[]) => {
            const current = this.entries.get(chatKey);

            if (entry.closedNotified || (current && current !== entry)) {
              return;
            }

            const next = tasks.map(({ id, kind, description }) => ({
              id,
              kind,
              description,
            }));

            if (JSON.stringify(next) === JSON.stringify(entry.backgroundTasks)) {
              return;
            }

            const wasSleeping = sleeping(entry);

            entry.backgroundTasks = next;

            // Во время open снимок сохраняется до присвоения handle и события opened.
            if (current !== entry) {
              return;
            }

            if (sleeping(entry)) {
              this._clearIdle(entry);
            } else if (wasSleeping) {
              entry.lastUsed = Date.now();
              this._armIdle(entry);
            }

            this.onChange?.({ chatKey, event: 'tasks' });
          },
          onProviderUsage: (patch: ProviderUsagePatch): boolean => {
            try {
              return spec.onProviderUsage?.(patch) ?? false;
            } catch (error) {
              this.log?.warn?.(
                { err: (error as Error)?.message, chatKey },
                'чат: живые квоты не приняты обработчиком',
              );

              return false;
            }
          },
          onBackgroundStart: () => {
            if (entry.background || entry.closedNotified) {
              return;
            }

            entry.background = { backgroundId: `bg-${randomUUID()}` };
            this._clearIdle(entry);
            this.log?.info?.({ chatKey }, 'чат: агент проснулся сам');
            this.onBackgroundStart?.({
              chatKey,
              identity: this._backgroundIdentity(entry),
              session: {
                executorId: entry.executorId,
                model: entry.model,
                cwd: entry.cwd,
                extraDirs: [...entry.extraDirs],
              },
            });
            this.onChange?.({ chatKey, event: 'busy' });
          },
          onBackgroundStep: (step: unknown) => {
            if (entry.background) {
              this.onBackgroundStep?.({
                chatKey,
                step,
                identity: this._backgroundIdentity(entry),
              });
            }
          },
          onBackgroundProgress: (tokens: unknown, extra: unknown) => {
            if (entry.background) {
              this.onBackgroundProgress?.({
                chatKey,
                tokens,
                extra,
                identity: this._backgroundIdentity(entry),
              });
            }
          },
          onBackground: (result: { sessionId?: string } | null) => {
            if (result?.sessionId) {
              entry.sessionId = result.sessionId;
            }
            if (!entry.background) {
              this.log?.warn?.({ chatKey }, 'чат: итог без открытого фона');

              return;
            }

            const identity = this._backgroundIdentity(entry);

            entry.background = null;
            this._wakeBackground(entry);
            entry.lastUsed = Date.now();

            if (!entry.managed && this.entries.get(chatKey) === entry) {
              this._armIdle(entry);
            }

            this.onChange?.({ chatKey, event: 'busy' });

            return Promise.resolve(this.onBackgroundTurn?.({
              chatKey,
              executorId: entry.executorId,
              result,
              identity,
            })).catch((error) => {
              this.log?.warn?.(
                { err: (error as Error)?.message, chatKey },
                'чат: публикация фонового ответа не завершилась',
              );
            });
          },
          onExit: ({ reason }: { reason?: string }) => {
            if (this.entries.get(chatKey) === entry) {
              this._forget(entry, reason || 'процесс завершился');
            } else {
              this._notifyClosed(entry, reason || 'процесс завершился');
            }
          },
        },
      });

      if (this.closed || spec.signal?.aborted) {
        await entry.handle.close();

        throw Object.assign(new Error('Ход остановлен до открытия живой сессии.'), {
          stopped: true,
          steps: [],
          sessionId: entry.sessionId,
        });
      }

      this.entries.set(chatKey, entry);

      if (!entry.background) {
        this._armIdle(entry);
      }

      this.log?.info?.(
        { chatKey, executor: entry.executorId, pid: entry.handle.pid },
        'чат: открыта живая сессия',
      );
      this.onChange?.({ chatKey, event: 'opened' });
      return entry;
    } finally {
      releaseOpening();
    }
  }

  /**
   * Потолок живых процессов — обязательная часть, а не отделка: каждый держит память
   * и свои MCP-серверы. Гасим самую давнюю СВОБОДНУЮ сессию; если свободных нет,
   * ход человека важнее потолка, но это остаётся в журнале.
   */
  async _enforceLimit(strict = false): Promise<void> {
    while (this.entries.size + this.opening >= this.maxSessions) {
      const idle = [...this.entries.values()]
        .filter((entry) => !entry.managed && !entry.background && !sleeping(entry) && !entry.keepAlive)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];

      if (!idle) {
        if (strict) {
          throw new Error('Нет свободного слота живых сессий. Закройте ненужный живой процесс агента.');
        }

        this.log?.warn?.(
          { live: this.entries.size, limit: this.maxSessions },
          'чат: все живые сессии заняты, потолок превышен',
        );
        return;
      }
      this._forget(idle, 'вытеснена по потолку живых сессий');
      await this._closeHandle(idle);
    }
  }

  /**
   * Проверка лимита и резервирование одного места атомарны относительно других opens.
   * Мьютекс держится только до резерва, а не во время native open или пользовательского prompt.
   */
  private async reserveOpening(strict: boolean): Promise<() => void> {
    const previous = this.admission;
    let unlock!: () => void;

    this.admission = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;

    try {
      if (this.closed) {
        throw new Error('Сервер останавливается — новая сессия не открывается.');
      }

      await this._enforceLimit(strict);
      this.opening += 1;

      let released = false;

      return () => {
        if (!released) {
          released = true;
          this.opening -= 1;
        }
      };
    } finally {
      unlock();
    }
  }

  /**
   * Ожидающий задачи процесс не получает автоматического таймера гашения.
   * После снятия защиты вызывающий начинает полный обычный интервал простоя.
   */
  _armIdle(entry: LiveEntry): void {
    this._clearIdle(entry);

    if (sleeping(entry) || entry.keepAlive) {
      return;
    }

    entry.idleTimer = setTimeout(() => {
      if (entry.managed || entry.background) {
        this._armIdle(entry);
        return;
      }
      this._forget(entry, 'простой');
      void this._closeHandle(entry);
    }, this.idleMs);
    entry.idleTimer?.unref?.();
  }

  /**
   * Закрывает процесс entry и помнит это закрытие по чату, пока оно не кончится.
   * Новый процесс того же чата `_acquire` поднимает только после него.
   */
  _closeHandle(entry: LiveEntry): Promise<void> {
    const done = entry.handle.close().then(() => {}, (error) => {
      if (entry.keepAlive) {
        throw error;
      }
    });
    const tracked = done.finally(() => {
      if (this.closing.get(entry.chatKey) === tracked) {
        this.closing.delete(entry.chatKey);
      }
    });

    this.closing.set(entry.chatKey, tracked);

    return tracked;
  }

  _clearIdle(entry: LiveEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  /**
   * Убирает entry из пула и однократно закрывает её фоновое поколение.
   * Поздний exit уже вытесненной entry не меняет нового владельца chatKey.
   */
  _forget(entry: LiveEntry, reason: string): void {
    this._clearIdle(entry);
    this._notifyClosed(entry, reason);
    const owned = this.entries.get(entry.chatKey) === entry;
    if (owned) this.entries.delete(entry.chatKey);
    this.log?.info?.({ chatKey: entry.chatKey, reason }, 'чат: живая сессия закрыта');
    // Оповещаем только владельца записи: вытесненная запись уже сообщила о себе,
    // и второй раз перечитывать список окнам незачем.
    if (owned) this.onChange?.({ chatKey: entry.chatKey, event: 'closed', reason });
  }

  /**
   * Прерывание относится к поколению процесса, породившему фон.
   * Поздняя команда старого поколения не затрагивает новый процесс чата.
   */
  interruptBackground(identity: BackgroundIdentity): boolean {
    const entry = this.entries.get(identity.chatKey);

    if (!entry?.handle.alive || entry.sessionToken !== identity.sessionToken || !entry.background) {
      return false;
    }

    void entry.handle.interrupt().catch((error) => {
      this.log?.warn?.({ err: (error as Error)?.message }, 'чат: фон не подтвердил прерывание');
    });

    return true;
  }

  /**
   * Страховочный стоп гасит только процесс нужного поколения.
   * Сохранённый id разговора позволяет следующему ходу восстановить сессию.
   */
  async closeGeneration(identity: BackgroundIdentity, reason: string): Promise<boolean> {
    if (this.entries.get(identity.chatKey)?.sessionToken !== identity.sessionToken) {
      return false;
    }

    try {
      await this.close(identity.chatKey, reason);
    } catch (error) {
      this.log?.warn?.({ err: (error as Error).message, chatKey: identity.chatKey },
        'чат: process scope не подтвердил завершение страховочного стопа');
    }

    return true;
  }

  private _backgroundIdentity(entry: LiveEntry): BackgroundIdentity {
    return {
      chatKey: entry.chatKey,
      sessionToken: entry.sessionToken,
      backgroundId: entry.background!.backgroundId,
    };
  }

  /**
   * Ожидание работающего фона снимается завершением, закрытием или abort хода.
   * Обработчик abort и запись ожидания удаляются при каждом исходе.
   */
  private _waitBackground(entry: LiveEntry, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      /**
       * Пробуждение снимает обработчик abort и своё ожидание из entry.
       * Повторный сигнал не оставляет подписку и не затрагивает следующий ход.
       */
      const wake = () => {
        signal?.removeEventListener('abort', wake);

        const index = entry.backgroundWaiters.indexOf(wake);

        if (index >= 0) {
          entry.backgroundWaiters.splice(index, 1);
        }

        resolve();
      };

      entry.backgroundWaiters.push(wake);
      signal?.addEventListener('abort', wake, { once: true });

      if (signal?.aborted) {
        wake();
      }
    });
  }

  private _wakeBackground(entry: LiveEntry): void {
    for (const resolve of entry.backgroundWaiters.splice(0)) {
      resolve();
    }
  }

  /**
   * Каждая entry сообщает о своём закрытии ровно один раз независимо от exit hook.
   * Ожидающие фон просыпаются и перечитывают текущего владельца chatKey.
   */
  private _notifyClosed(entry: LiveEntry, reason: string): void {
    if (entry.closedNotified) {
      return;
    }

    entry.closedNotified = true;
    entry.background = null;
    entry.backgroundTasks = [];
    this._wakeBackground(entry);
    this.onSessionClosed?.({
      chatKey: entry.chatKey,
      reason,
      sessionToken: entry.sessionToken,
    });
  }
}
