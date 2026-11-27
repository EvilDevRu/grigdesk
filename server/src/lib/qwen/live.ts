import { promises as fs } from 'node:fs';

import type { ExecutorRunInput, ExecutorRunResult } from '../executors/index.ts';
import { settingsFingerprint } from '../executorSettings/fingerprint.ts';
import { validateWorkdirPath } from '../chat/workdir.ts';
import type { QwenBackgroundHooks } from './background.ts';
import { runQwenTurn } from './runtime.ts';
import { qwenConfig, readQwenSnapshot } from './settings.ts';
import { openQwenTransport, record } from './transport.ts';
import { resolveQwenWorkspace } from './workspace.ts';
import type { QwenOwnedProcess } from './sandbox.ts';

type Transport = Awaited<ReturnType<typeof openQwenTransport>>;
type Handlers = NonNullable<Parameters<typeof openQwenTransport>[3]>;
type LiveSpec = ExecutorRunInput & { hooks?: QwenBackgroundHooks };

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
 * Один handle владеет scope, закреплённой ACP-сессией и callbacks текущего хода.
 * Live-сессия сохраняет native runner между ходами; session/load нужен после выхода процесса.
 */
class QwenLiveSession {
  private transport?: Transport;
  private opening?: Promise<Transport>;
  private owned?: QwenOwnedProcess;
  private handlers?: Handlers;
  private session?: Record<string, unknown>;
  private sessionId: string;
  private closeJob?: Promise<void>;
  private failed = false;
  private closed = false;
  private readonly shutdown = new AbortController();
  private current?: AbortController;
  private readonly prompts = new Set<Promise<unknown>>();
  private readonly spec: LiveSpec;

  constructor(spec: LiveSpec) {
    this.spec = spec;
    this.sessionId = spec.sessionId || '';
  }

  get alive(): boolean {
    return !this.closed && !this.failed && this.transport?.client.closed !== true;
  }

  get pid(): number | null {
    return this.owned?.child.pid || null;
  }

  /**
   * Состояние текущей модели относится к открытому native sessionId.
   * Кадры другой сессии не меняют метаданные и не проходят в callbacks хода.
   */
  private notify(method: string, value: unknown) {
    const params = record(value);

    if (this.closed || params.sessionId !== this.sessionId) {
      return;
    }

    const update = record(params.update);

    if (method === 'session/update' && update.sessionUpdate === 'config_option_update' && this.session) {
      this.session.configOptions = update.configOptions;
    }

    return this.handlers?.onNotification?.(method, value);
  }

  /**
   * Область процесса запоминается до handshake. После ошибки подготовки вызывающий
   * пул может подтвердить закрытие той же области, не запуская другой процесс.
   */
  private attach: typeof openQwenTransport = async (config, snapshot, options, handlers = {}) => {
    this.handlers = handlers;

    if (!this.transport) {
      const opening = openQwenTransport(config, snapshot, {
        ...options,
        onOwnedProcess: (resource) => {
          this.owned = resource;
        },
      }, {
        onNotification: (method, value) => this.notify(method, value),
        onReverseRequest: (method, value) => {
          if (this.closed || !this.handlers?.onReverseRequest) {
            return { outcome: { outcome: 'cancelled' } };
          }

          return this.handlers.onReverseRequest(method, value);
        },
      });

      this.opening = opening;

      try {
        const transport = await opening;

        this.shutdown.signal.throwIfAborted();
        this.transport = transport;
        this.spec.hooks?.onActivity?.({
          state: 'unknown',
          reasons: [{ kind: 'unknown' }],
        });
        transport.child.once('close', () => {
          void this.close().catch(() => {
            const log = record(this.spec.log);

            if (typeof log.warn === 'function') {
              log.warn({ code: 'qwen_host_scope_close_failed' },
                'Qwen: не удалось закрыть свою область процессов');
            }
          });
        });
      } catch (error) {
        this.failed = true;

        throw error;
      } finally {
        this.opening = undefined;
      }
    }

    const transport = this.transport;

    return {
      ...transport,
      client: {
        ...transport.client,
        request: (method: string, params?: unknown, timeoutMs?: number) => {
          return this.request(transport, method, params, timeoutMs);
        },
      },
      close: async () => {
        this.handlers = undefined;

        if (this.prompts.size || transport.workMcpUnavailable()) {
          await this.close();
        }
      },
    };
  };

  /**
   * Загрузка одной сессии выполняется единожды на процесс. Повторный ход читает её
   * последние опции из ACP и сохраняет те же права, модель и MCP текущего handle.
   */
  private async request(transport: Transport, method: string, params: unknown, timeoutMs?: number) {
    if (method === 'session/load' && this.session) {
      if (record(params).sessionId !== this.sessionId) {
        throw new Error('Qwen: чужая identity открытой сессии «Хост».');
      }

      return this.session;
    }

    const pending = transport.client.request(method, params, timeoutMs);

    if (method === 'session/prompt') {
      this.prompts.add(pending);
    }

    try {
      const result = await pending;

      if (method === 'session/new' || method === 'session/load') {
        this.session = record(result);
        this.sessionId = String(this.session.sessionId || record(params).sessionId || '');
      }

      return result;
    } finally {
      this.prompts.delete(pending);
    }
  }

  /**
   * Пул удерживает один foreground. Новый ход получает свои callbacks и вложения,
   * а выключение процесса и «Стоп» отменяют только этого владельца.
   */
  async send(turn: Partial<ExecutorRunInput>): Promise<ExecutorRunResult> {
    if (!this.alive || this.current) {
      throw new Error('Qwen: живая сессия недоступна для нового хода.');
    }

    const current = new AbortController();
    const signal = AbortSignal.any([this.shutdown.signal, current.signal,
      ...(turn.signal ? [turn.signal] : [])]);

    this.current = current;

    try {
      return await runQwenTurn({
        ...this.spec,
        ...turn,
        config: this.spec.config,
        cwd: this.spec.cwd,
        extraDirs: this.spec.extraDirs,
        providerSettings: this.spec.providerSettings,
        signal,
        sessionId: this.sessionId || this.spec.sessionId,
        attachmentPaths: turn.attachmentPaths || [],
      }, { openTransport: this.attach });
    } finally {
      this.current = undefined;
      this.handlers = undefined;
    }
  }

  async interrupt(): Promise<void> {
    this.current?.abort();
  }

  /**
   * Разрыв канала запрещает новые разрешения. При ошибке закрытия scope тот же
   * объект остаётся доступен пулу для повторной попытки системного завершения.
   */
  close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();

    this.closeJob ??= (async () => {
      // Область уже известна во время handshake. Её закрытие разблокирует reader,
      // даже если CLI никогда не ответит на initialize.
      if (!this.transport && this.owned) {
        await this.owned.close();
      }

      await this.opening?.catch(() => undefined);

      if (this.transport) {
        await this.transport.close();
      } else {
        await this.owned?.close();
      }

      this.owned = undefined;
      this.spec.hooks?.onExit?.({ reason: 'процесс Qwen завершён' });
    })().catch((error) => {
      this.closeJob = undefined;

      throw error;
    });

    return this.closeJob;
  }
}

/**
 * Граница привязки закреплена fingerprint живого пула, а путь программы определяет
 * проверяемый рантайм сервера. Ни один из них не берётся из текста инструмента.
 */
export async function openQwenLiveSession(spec: LiveSpec) {
  return new QwenLiveSession(spec);
}
