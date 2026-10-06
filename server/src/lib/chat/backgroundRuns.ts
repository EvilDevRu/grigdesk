// Фоновый цикл живого процесса становится обычным запуском чата с собственным runId.
// Поколение процесса и id цикла отделяют позднюю публикацию от следующего запуска.
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { ChatRunSnapshot } from '../../../../shared/chatRun.ts';
import { normalizeContextUsage, type ChatContextUsage } from '../../../../shared/chatContextUsage.ts';
import { normalizeContextCache, type ContextCache } from './contextCache.ts';
import { MAX_CHAT_STEPS, pushChatStep, type ChatStep } from './streamSteps.ts';

export interface BackgroundIdentity {
  chatKey: string;
  sessionToken: string;
  backgroundId: string;
}

export interface BackgroundSession {
  executorId: string;
  model: string;
  cwd: string;
  extraDirs: string[];
}

export interface BackgroundRunsPorts {
  broadcast: (event: string, data: Record<string, unknown>) => void;
  hiddenDirs: readonly string[];
  managedActive: (chatKey: string) => boolean;
  queuedCount: (chatKey: string) => number;
  log?: { error?: (fields: Record<string, unknown>, message: string) => void };
  now?: () => number;
  newRunId?: () => string;
}

interface BackgroundRecord extends BackgroundIdentity, ChatContextUsage {
  state: 'running' | 'publishing';
  runId: string;
  startedAt: number;
  visible: boolean;
  snapshot: ChatRunSnapshot | null;
  steps: ChatStep[];
  tokens: number;
  tokensIsEstimate?: boolean;
  contextCache?: ContextCache;
}

/**
 * Служебные корни доступны исполнителю, но не являются пользовательскими папками хода.
 * Сравнение нормализует пути, сохраняя порядок и значения исходного массива.
 */
export function visibleExtraDirs(dirs: readonly string[], hidden: readonly string[]): string[] {
  const excluded = new Set(hidden.map((dir) => path.resolve(dir)));

  return dirs.filter((dir) => !excluded.has(path.resolve(dir)));
}

export class ChatBackgroundRuns {
  private records = new Map<string, BackgroundRecord>();
  private waiters = new Set<() => void>();
  private closed = false;
  private ports: BackgroundRunsPorts;
  private now: () => number;
  private newRunId: () => string;

  constructor(ports: BackgroundRunsPorts) {
    this.ports = ports;
    this.now = ports.now ?? Date.now;
    this.newRunId = ports.newRunId ?? (() => `run-${randomUUID()}`);
  }

  private key(identity: BackgroundIdentity): string {
    return `${identity.sessionToken}:${identity.backgroundId}`;
  }

  /**
   * Регистрирует каждый цикл ровно один раз и фиксирует параметры его процесса.
   * Фон рядом с управляемым запуском хранится скрытым до освобождения чата.
   */
  start(identity: BackgroundIdentity, session: BackgroundSession): string {
    const key = this.key(identity);
    const existing = this.records.get(key);

    if (existing) {
      return existing.runId;
    }

    const runId = this.newRunId();
    const snapshot: ChatRunSnapshot | null = session.executorId && session.model && session.cwd ? {
      chatKey: identity.chatKey,
      runId,
      providerId: session.executorId,
      requestedModelId: session.model,
      cwd: session.cwd,
      extraDirs: visibleExtraDirs(session.extraDirs, this.ports.hiddenDirs),
    } : null;
    const record: BackgroundRecord = {
      ...identity,
      state: 'running',
      runId,
      startedAt: this.now(),
      visible: !this.ports.managedActive(identity.chatKey),
      snapshot,
      steps: [],
      tokens: 0,
    };

    this.records.set(key, record);

    if (record.visible) {
      this.announce(record);
    }

    return runId;
  }

  /**
   * Копия ленты ограничена, но живой поток продолжает доставлять каждый шаг.
   * События завершённого или неизвестного цикла не касаются нового запуска.
   */
  step(identity: BackgroundIdentity, step: ChatStep): void {
    const record = this.records.get(this.key(identity));

    if (!record || record.state !== 'running') {
      return;
    }

    pushChatStep(record.steps, step, MAX_CHAT_STEPS);

    if (record.visible) {
      this.ports.broadcast('chat-step', { ...this.eventIdentity(record), step });
    }
  }

  /**
   * Отдельные порции прогресса обновляют только переданные измерения.
   * Последний снимок сохраняет и явный false у признаков приблизительных чисел.
   */
  progress(identity: BackgroundIdentity, tokens: unknown, extra: unknown): void {
    const record = this.records.get(this.key(identity));

    if (!record || record.state !== 'running') {
      return;
    }

    const fields = extra && typeof extra === 'object' ? extra as Record<string, unknown> : {};

    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
      record.tokens = tokens;
    }
    if (typeof fields.tokensIsEstimate === 'boolean') {
      record.tokensIsEstimate = fields.tokensIsEstimate;
    }

    Object.assign(record, normalizeContextUsage(extra));

    const cache = normalizeContextCache(fields.contextCache);

    if (cache) {
      record.contextCache = cache;
    }
    if (record.visible) {
      this.ports.broadcast('chat-progress', { ...this.eventIdentity(record), ...this.metrics(record) });
    }
  }

  /**
   * Публикация удерживает очередь до устойчивой записи результата в pending.
   * Ошибка записи закрывает индикатор, но не имитирует доставку ответа.
   */
  async publish(identity: BackgroundIdentity, persist: (runId: string) => Promise<void>): Promise<void> {
    const record = this.records.get(this.key(identity));

    if (!record || record.state !== 'running') {
      return;
    }

    record.state = 'publishing';

    try {
      await persist(record.runId);
    } catch (error) {
      this.ports.log?.error?.(
        { err: (error as Error)?.message, chatKey: record.chatKey },
        'Не удалось записать фоновый ответ',
      );
    } finally {
      this.settle(record);
    }
  }

  /**
   * Смерть поколения завершает только его работающие циклы без ответа.
   * Начатая запись pending сама закроется после окончания публикации.
   */
  closeSession(sessionToken: string): void {
    for (const record of this.records.values()) {
      if (record.sessionToken === sessionToken && record.state === 'running') {
        this.settle(record);
      }
    }
  }

  /**
   * Управляемый запуск временно скрывает живые фоновые циклы чата.
   * Их идентичность и накопленная лента сохраняются для последующего reveal.
   */
  hide(chatKey: string): void {
    for (const record of this.records.values()) {
      if (record.chatKey === chatKey && record.state === 'running') {
        record.visible = false;
      }
    }
  }

  /**
   * Освободившийся чат снова показывает живой скрытый цикл с прежним runId.
   * Накопленные шаги и время передаются как восстановление обычного запуска.
   */
  reveal(chatKey: string): void {
    if (this.closed || this.ports.managedActive(chatKey)) {
      return;
    }

    for (const record of this.records.values()) {
      if (record.chatKey === chatKey && record.state === 'running' && !record.visible) {
        record.visible = true;
        this.announce(record, true);
      }
    }
  }

  has(chatKey: string): boolean {
    return [...this.records.values()].some((record) => record.chatKey === chatKey);
  }

  runningIdentity(chatKey: string): (BackgroundIdentity & { runId: string }) | null {
    const record = [...this.records.values()].find((item) => (
      item.chatKey === chatKey && item.state === 'running'
    ));

    return record ? {
      chatKey: record.chatKey,
      sessionToken: record.sessionToken,
      backgroundId: record.backgroundId,
      runId: record.runId,
    } : null;
  }

  /**
   * Управляемый запуск ждёт всех циклов чата, включая публикацию результата.
   * Слив сервера будит ожидание, чтобы очередь могла завершиться отказом.
   */
  async waitUntilIdle(chatKey: string): Promise<void> {
    while (!this.closed && this.has(chatKey)) {
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  /**
   * Слив даёт уже начатым записям ограниченное время завершить pending.
   * Таймер удаляется и при раннем окончании, не задерживая остановку сервера.
   */
  async whenPublished(timeoutMs: number): Promise<void> {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      this.wake();
    }, Math.max(0, timeoutMs));

    try {
      while (!expired && [...this.records.values()].some((record) => record.state === 'publishing')) {
        await new Promise<void>((resolve) => this.waiters.add(resolve));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Для сверки окна выбирается последний цикл каждого чата.
   * Выдаваемый снимок не разрешает вызывающему менять состояние реестра.
   */
  list(): Array<Record<string, unknown>> {
    const latest = new Map<string, BackgroundRecord>();

    for (const record of this.records.values()) {
      const previous = latest.get(record.chatKey);

      if (!previous || record.startedAt >= previous.startedAt) {
        latest.set(record.chatKey, record);
      }
    }

    return [...latest.values()].map((record) => ({
      ...this.eventIdentity(record),
      snapshot: record.snapshot ? { ...record.snapshot, extraDirs: [...record.snapshot.extraDirs] } : null,
      startedAt: record.startedAt,
      elapsedMs: Math.max(0, this.now() - record.startedAt),
      steps: record.steps.map((step) => ({ ...step })),
      compact: false,
      ...this.metrics(record),
    }));
  }

  private eventIdentity(record: BackgroundRecord): Record<string, unknown> {
    return {
      chatKey: record.chatKey,
      runId: record.runId,
      source: 'background',
    };
  }

  /**
   * Собирает только известные метрики цикла для SSE и восстановления.
   * Копия кэша не даёт внешнему потребителю менять запись реестра.
   */
  private metrics(record: BackgroundRecord): Record<string, unknown> {
    return {
      tokens: record.tokens,
      ...(typeof record.tokensIsEstimate === 'boolean' ? { tokensIsEstimate: record.tokensIsEstimate } : {}),
      ...normalizeContextUsage(record),
      ...(record.contextCache ? { contextCache: { ...record.contextCache } } : {}),
    };
  }

  /**
   * Первичное объявление и восстановление используют один контракт старта.
   * Только восстановлению нужны накопленные метрики, шаги и прошедшее время.
   */
  private announce(record: BackgroundRecord, restored = false): void {
    this.ports.broadcast('chat-turn-start', {
      ...this.eventIdentity(record),
      at: record.startedAt,
      snapshot: record.snapshot,
      compact: false,
      ...(restored ? {
        restored: true,
        elapsedMs: Math.max(0, this.now() - record.startedAt),
        steps: record.steps.map((step) => ({ ...step })),
        ...this.metrics(record),
      } : {}),
    });
  }

  /**
   * Завершение принадлежит захваченной записи, а не текущему циклу chatKey.
   * Даже скрытый запуск посылает done для ожидающих и сверки окна.
   */
  private settle(record: BackgroundRecord): void {
    const key = this.key(record);

    if (this.records.get(key) !== record) {
      return;
    }

    this.records.delete(key);
    this.ports.broadcast('chat-done', {
      ...this.eventIdentity(record),
      queued: this.ports.queuedCount(record.chatKey),
    });
    this.wake();
  }

  private wake(): void {
    const waiting = [...this.waiters];

    this.waiters.clear();
    waiting.forEach((resolve) => resolve());
  }
}
