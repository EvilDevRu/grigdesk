import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ChildProcess } from 'node:child_process';

import { createAcpClient, initializeAcp } from '../../server/src/lib/acp/client.ts';
import { resolveDeepSeekRuntime } from '../../server/src/lib/deepseek/runtimeProcess.ts';
import { openDeepSeekStream } from '../../server/src/lib/deepseek/serverEvents.ts';
import type { DeepSeekWireFrame } from '../../server/src/lib/deepseek/serverEvents.ts';
import { startDeepSeekServer } from '../../server/src/lib/deepseek/serverRuntime.ts';
import type { DeepSeekServerProcess } from '../../server/src/lib/deepseek/serverRuntime.ts';
import { GLM_RESEARCH_KEY } from './glmResearchOverlay.mts';

export interface GlmWaterfall {
  event: string;
  eventId: string;
  request: Record<string, unknown>;
}

export interface GlmTurnRecord {
  sessionId: string;
  events: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  waterfalls: GlmWaterfall[];
  turnEnd: Record<string, unknown> | null;
}

type Outcome = { kind: string; value?: unknown };

/**
 * Окружение процесса стенда: только системные имена и служебный ключ маршрута.
 * Модельных ключей службы и настоящего home в процесс не попадает.
 */
export function glmResearchEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
    GRIGDESK_GLM_ROUTE_KEY: GLM_RESEARCH_KEY,
    ...extra,
  };
}

/**
 * Web-процесс GLM поднимается штатным launcher-ом DeepSeek с GLM-overlay.
 * Хвост stderr без токена входа добавляется к ошибке старта для диагностики.
 */
export async function startGlmWeb(options: {
  artifact: string;
  overlayPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<DeepSeekServerProcess & { diagnostics: () => string }> {
  let diagnostics = '';
  const server = await startDeepSeekServer({
    runtime: resolveDeepSeekRuntime({ deepseekArtifactDir: options.artifact }),
    bin: process.execPath,
    overlayPath: options.overlayPath,
    cwd: options.cwd,
    env: options.env,
    spawnProcess: ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);

      child.stderr?.on('data', (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-16_384);
      });

      return child;
    }) as typeof spawn,
  }).catch((error: Error) => {
    throw new Error(`${error.message}\n${diagnostics.replace(/token=\S+/gu, 'token=<redacted>')}`);
  });

  return {
    ...server,
    diagnostics: () => diagnostics.replace(/token=\S+/gu, 'token=<redacted>'),
  };
}

/**
 * Один ход по web-RPC: create/resume, выбор модели, follow и $events, prompt, turn/end.
 * Спросы отдаются тесту; без обработчика approval отклоняется, вопрос остаётся без ответа.
 */
export async function runGlmTurn(server: DeepSeekServerProcess, options: {
  cwd: string;
  message: string;
  sessionId?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  onWaterfall?: (item: GlmWaterfall, record: GlmTurnRecord) => Outcome | Promise<Outcome>;
  onEvent?: (event: Record<string, unknown>, record: GlmTurnRecord) => void;
}): Promise<GlmTurnRecord> {
  const sessionId = await server.client.createSession(options.cwd, options.sessionId);
  const record: GlmTurnRecord = {
    sessionId,
    events: [],
    chunks: [],
    waterfalls: [],
    turnEnd: null,
  };

  if (options.model) {
    await server.client.rpc('session/selectModel', {
      request: {
        sessionId,
        provider: 'zai',
        model: options.model,
        ...(options.effort ? { reasoningEffort: options.effort } : {}),
      },
    });
  }

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const done = {
    promise: finished,
    resolve: () => resolveDone(),
    reject: (error: Error) => rejectDone(error),
  };
  let clientId = '';
  let started = false;
  const follow = openDeepSeekStream({
    client: server.client,
    endpoint: 'session/follow',
    args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } },
    onItem: (item: DeepSeekWireFrame) => {
      if (item.type === 'assistant-stream') {
        const frame = item.frame as Record<string, unknown>;

        if (frame?.type === 'chunk') {
          record.chunks.push(frame.chunk as Record<string, unknown>);
        }

        return;
      }

      if (item.type !== 'event') {
        return;
      }

      const event = item.event as Record<string, unknown>;

      record.events.push(event);
      options.onEvent?.(event, record);

      if (event.type === 'turn/start') {
        started = true;
      }

      if (event.type === 'turn/end' && started) {
        record.turnEnd = event;
        done.resolve();
      }
    },
    onClose: (error) => done.reject(error),
  });
  const remote = openDeepSeekStream({
    client: server.client,
    endpoint: '$events',
    args: {},
    onItem: (item: DeepSeekWireFrame) => {
      if (item.type === 'ready') {
        clientId = String(item.clientId || '');

        return;
      }

      if (item.type !== 'waterfall') {
        return;
      }

      const waterfall = {
        event: String(item.event),
        eventId: String(item.eventId || ''),
        request: (item.request ?? {}) as Record<string, unknown>,
      };

      record.waterfalls.push(waterfall);

      void (async () => {
        const outcome = options.onWaterfall
          ? await options.onWaterfall(waterfall, record)
          : waterfall.event === 'approval/request'
            ? { kind: 'result', value: 'rejected' }
            : { kind: 'next' };

        await server.client.answerEvent(clientId, waterfall.eventId, outcome);
      })().catch((error) => done.reject(error));
    },
    onClose: (error) => done.reject(error),
  });
  const timer = setTimeout(() => done.reject(new Error('Таймаут хода GLM на стенде')),
    options.timeoutMs ?? 45_000);

  try {
    await Promise.all([follow.ready, remote.ready]);
    await server.client.prompt(sessionId, options.message, randomUUID(), 'queue');
    await done.promise;
  } finally {
    clearTimeout(timer);
    follow.close();
    remote.close();
  }

  return record;
}

/**
 * ACP-процесс для каталожных фактов: initialize без ключа и сессия без prompt.
 * Остановка закрывает клиент и ждёт выхода только своего дочернего процесса.
 */
export async function startGlmAcp(options: {
  artifact: string;
  overlayPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) {
  const runtime = resolveDeepSeekRuntime({ deepseekArtifactDir: options.artifact });
  const child: ChildProcess = spawn(runtime.command, [
    ...runtime.prefixArgs, '--profile', 'acp', '--patch', options.overlayPath,
  ], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let diagnostics = '';

  child.stderr?.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-16_384);
  });

  const client = createAcpClient(child, { requestTimeoutMs: 30_000 });

  await initializeAcp(client, 15_000);

  return {
    client,
    diagnostics: () => diagnostics,
    stop: async () => {
      client.close();

      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    },
  };
}
