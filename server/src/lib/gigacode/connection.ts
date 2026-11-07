import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { createAcpClient, initializeAcp } from '../acp/client.ts';
import type { WorkToolsPort } from '../executors/workIpc.ts';
import { createWorkIpc } from '../executors/workIpc.ts';
import { buildGigaCodeProfile, gigaCodeError } from './profile.ts';
import type { GigaCodeProfileOptions } from './profile.ts';
import { probeGigaCode } from './discovery.ts';
import { cleanRunnerFailureMessage } from '../runnerFailure.ts';
import { createGigaCodeRedaction } from './redaction.ts';

export interface GigaCodeDeps {
  spawn?: typeof spawn;
  createWorkIpc?: typeof createWorkIpc;
  termTimeoutMs?: number;
}

export interface GigaCodeConnectionOptions extends GigaCodeProfileOptions {
  signal?: AbortSignal;
  metadataTimeoutMs?: number;
  timeoutMs?: number;
  workTools?: WorkToolsPort;
  mcpName?: string;
  onNotification?: (method: string, params: any) => unknown;
  onReverseRequest?: (method: string, params: any) => Promise<unknown>;
}

/**
 * Один owner создаёт и закрывает namespace, ACP и собственный MCP на всех исходах.
 * Закрытие ограничено по времени и убирает process group даже после смерти лидера.
 */
export async function openGigaCodeConnection(options: GigaCodeConnectionOptions, deps: GigaCodeDeps = {}) {
  const stopped = () => gigaCodeError('gigacode_stopped', 'Ход GigaCode остановлен');

  if (options.signal?.aborted) {
    throw stopped();
  }

  const probe = await probeGigaCode(options.config);

  if (!probe.ok) {
    throw gigaCodeError(probe.code || 'gigacode_probe_failed', 'Установка GigaCode не прошла проверку');
  }

  let ready = false;
  let closed = false;
  const ipc = options.workTools ? await (deps.createWorkIpc || createWorkIpc)({
    workTools: {
      descriptors: options.workTools.descriptors,
      invoke: (name, input) => {
        if (closed) {
          return Promise.reject(stopped());
        }

        return options.workTools!.invoke(name, input);
      },
    },
    onReady: () => {
      ready = true;
    },
  }) : null;
  let profile: Awaited<ReturnType<typeof buildGigaCodeProfile>>;

  try {
    profile = await buildGigaCodeProfile({
      ...options,
      readonlyRuntimePaths: ipc ? [
        path.dirname(ipc.socketPath), ipc.mcpServer.command, ipc.mcpServer.args[0]!,
      ] : [],
    });
  } catch (error) {
    await ipc?.close();

    throw error;
  }

  if (options.signal?.aborted) {
    await ipc?.close();
    await profile.cleanup();

    throw stopped();
  }

  /**
   * Известные токен и IPC nonce удаляются до передачи любых provider полей в UI.
   * Редактор диагностики дополнительно убирает неизвестные секретные присваивания.
   */
  const { redact, stream } = createGigaCodeRedaction([profile.secret, ipc?.nonce || '']);
  const publicParams = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value,
    (_key, item) => typeof item === 'string' ? redact(item) : item));
  const streams = new Map<string, { filter: ReturnType<typeof stream>; params: any }>();

  /**
   * Остаток публикуется после terminal, ошибки или Stop до сборки итогового ответа.
   * Один flush очищает все каналы и не повторяет уже доставленные chunks.
   */
  function finishNotifications() {
    const remaining = [...streams.values()];

    streams.clear();

    for (const item of remaining) {
      const text = item.filter.finish();

      if (text) {
        options.onNotification?.('session/update', {
          ...item.params,
          update: { ...item.params.update, content: { type: 'text', text } },
        });
      }
    }
  }

  let child: ReturnType<typeof spawn>;

  try {
    child = (deps.spawn || spawn)(profile.command, profile.args, {
      cwd: profile.cwd,
      env: {},
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    await ipc?.close();
    await profile.cleanup();

    throw error;
  }

  const client = createAcpClient(child, {
    strict: true,
    maxLineBytes: 1024 * 1024,
    requestTimeoutMs: options.timeoutMs || 24 * 60 * 60 * 1000,
    onNotification: (method, params) => {
      if (!closed) {
        const safe = publicParams(params);
        const raw = params as any;
        const update = raw?.update;

        if (method === 'session/update' && update?.content?.type === 'text'
          && ['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate)) {
          const key = update.sessionUpdate;
          const item = streams.get(key) || { filter: stream(), params: safe };

          streams.set(key, item);
          safe.update.content.text = item.filter.push(String(update.content.text || ''));
        }

        return options.onNotification?.(method, safe);
      }
    },
    onReverseRequest: options.onReverseRequest
      ? (method, params) => options.onReverseRequest!(method, publicParams(params)) : undefined,
  });

  let stderr = '';

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-65536);
  });

  /**
   * Диагностика stderr дополняет только потерянный terminal, сохраняя RPC-приоритет.
   * Ограничение длины и обезличивание выполняются до любого публичного потребителя.
   */
  function failureMessage(error: unknown) {
    const source = error as { message?: unknown };
    const message = String(source.message || 'Ошибка GigaCode');
    const detail = /^ACP (?:process|transport|client|timeout)/u.test(message) && stderr.trim()
      ? `${message}: ${stderr}` : message;

    return cleanRunnerFailureMessage(redact(detail));
  }

  /**
   * Адресуется только process group, созданная этим owner через detached spawn.
   * Отсутствующий PID не даёт оснований сигналить чужому процессу или всему серверу.
   */
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch { /* Уже завершилась только наша группа. */ }
    }
  };
  const abort = () => {
    client.close();
    kill('SIGTERM');
  };

  options.signal?.addEventListener('abort', abort, { once: true });

  /**
   * Единственный finalizer закрывает transport до удаления private home.
   * SIGKILL посылается и после раннего exit, чтобы не оставить дочерние tools.
   */
  async function close() {
    if (closed) {
      return;
    }

    closed = true;
    options.signal?.removeEventListener('abort', abort);
    client.close();
    kill('SIGTERM');

    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        delay(deps.termTimeoutMs ?? 250),
      ]);
    }

    kill('SIGKILL');

    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        delay(1000),
      ]);
    }

    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    await ipc?.close();
    await profile.cleanup();
  }

  try {
    if (options.signal?.aborted) {
      throw stopped();
    }

    const timeout = options.metadataTimeoutMs ?? 10000;
    const initialized = await initializeAcp(client, timeout) as any;

    if (initialized?.protocolVersion !== 1 || initialized?.agentInfo?.name !== 'gigacode') {
      throw gigaCodeError('gigacode_protocol_unsupported', 'Неподдерживаемая ACP identity GigaCode');
    }

    const session = await client.request('session/new', {
      cwd: profile.cwd,
      mcpServers: ipc ? [{ name: options.mcpName || 'grigdesk-work', ...ipc.mcpServer }] : [],
    }, timeout) as any;

    if (typeof session?.sessionId !== 'string' || !session.sessionId) {
      throw gigaCodeError('gigacode_invalid_session', 'CLI не вернул идентификатор сессии');
    }

    const deadline = Date.now() + timeout;

    while (ipc && !ready && Date.now() < deadline && !options.signal?.aborted && !client.closed) {
      await delay(10);
    }

    if (ipc && !ready) {
      throw gigaCodeError('gigacode_mcp_unavailable', 'Обязательный MCP не подтвердил tools/list');
    }

    return {
      client,
      session,
      close,
      child,
      redact,
      finishNotifications,
      failureMessage,
      fingerprint: profile.fingerprint,
      cliVersion: probe.version!,
    };
  } catch (error) {
    await close();

    if (options.signal?.aborted) {
      throw stopped();
    }

    const source = error as { code?: unknown; message?: unknown };

    throw Object.assign(new Error(failureMessage(error)), {
      code: source.code,
    });
  }
}
