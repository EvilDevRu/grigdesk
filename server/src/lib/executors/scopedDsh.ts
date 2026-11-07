import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from '../../../../shared/lib/objects.ts';
import { createScopedWorkspaceTools } from './scopedWorkspace.ts';
import { createWorkIpc } from './workIpc.ts';
import type { WorkToolsPort } from './workIpc.ts';
import { waitForDshOperation } from '../deepseek/abortableOperation.ts';
import { runDeepSeekServerTurn } from '../deepseek/serverTurn.ts';
import type { DeepSeekServerTurnOptions, DeepSeekTurnVariant } from '../deepseek/serverTurn.ts';
import { startDeepSeekServer } from '../deepseek/serverRuntime.ts';
import type { DeepSeekRuntimeDescriptor } from '../deepseek/runtimeProcess.ts';
import { glmMcpToolName } from '../glm/policy.ts';

// Модуль загружается самим Harness из одноразового server-owned overlay.
// В нём нет зависимостей от исходников GrigDesk или приватных пакетов распакованной поставки.
const GUARD_SOURCE = `import { writeFile } from 'node:fs/promises';
export const name = 'grigdesk-triage-guard';
export const inject = ['tools'];
export async function apply(ctx, config) {
  const allowed = new Set(config.allowed);
  ctx.tools.guard((exec) => allowed.has(exec.name)
    ? undefined : 'Триаж разрешает только собственные файловые инструменты');
  await writeFile(config.proofPath, JSON.stringify({ nonce: config.nonce, allowed: config.allowed }),
    { mode: 0o600, flag: 'wx' });
}
`;

export type ScopedDshOptions = Pick<DeepSeekServerTurnOptions,
  'cwd' | 'message' | 'model' | 'effort' | 'signal' | 'onStep' | 'onProgress' | 'onRunMetadata'> & {
  workspaceAccess: unknown;
  workTools?: WorkToolsPort | null;
};

export interface ScopedDshRoute {
  runtime: DeepSeekRuntimeDescriptor;
  childEnv: (home: string) => NodeJS.ProcessEnv;
  rows?: Array<Record<string, unknown>>;
  insert?: Array<Record<string, unknown>>;
  startServer?: typeof startDeepSeekServer;
}

const MODEL_ONLY_GUARD = `import { writeFile } from 'node:fs/promises';
export const name = 'grigdesk-model-only-guard';
export const inject = ['tools'];
export async function apply(ctx, config) {
  ctx.tools.guard(() => 'Model-only запрещает инструменты');
  let calls = 0;
  ctx.on('llm/stream', async function* (request, next) {
    if ((request.tools?.length ?? 0) !== 0 || ++calls !== 1) {
      throw new Error('Model-only: недопустимый запрос');
    }
    let bytes = 0;
    let completed = false;
    for await (const chunk of next()) {
      bytes += Buffer.byteLength(JSON.stringify(chunk));
      if (bytes > 2097152 || chunk.type === 'tool-call-delta'
        || chunk.type === 'block-start' && chunk.blockType === 'tool-call'
        || chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        throw new Error('Model-only: недопустимый ответ');
      }
      if (chunk.type === 'finish') {
        if (chunk.reason?.kind !== 'stop') {
          throw new Error('Model-only: незавершённый ответ');
        }
        completed = true;
      }
      yield chunk;
    }
    if (!completed) {
      throw new Error('Model-only: отсутствует завершение ответа');
    }
  }, { global: true, prepend: true });
  await writeFile(config.proofPath, JSON.stringify({ nonce: config.nonce, allowed: [] }),
    { mode: 0o600, flag: 'wx' });
}
`;

export interface ModelOnlyDshOptions {
  message: string;
  model: string;
  effort?: string;
  images?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Ошибки model-only используют только фиксированный текст и код.
 * Сырой upstream error не раскрывает выбранные файлы, ключи и служебные URL.
 */
function modelOnlyError(code: string) {
  return Object.assign(new Error('Не удалось выполнить изолированный вызов модели.'), {
    code
  });
}

/**
 * Валидация проводится до metadata, файлов и процессов; общий caller может повторить её.
 * Непустые изображения не превращаются в текст и не теряются молча.
 */
export function validateModelOnlyInput(options: ModelOnlyDshOptions) {
  if (options.signal?.aborted) {
    throw modelOnlyError('model_run_aborted');
  }
  if (options.images !== undefined && (!Array.isArray(options.images) || options.images.length)) {
    throw modelOnlyError('unsupported_media');
  }
  if (typeof options.message !== 'string' || options.message.length > 131072
    || typeof options.model !== 'string' || !options.model) {
    throw modelOnlyError('model_input_invalid');
  }

  let pair: unknown;

  try {
    pair = JSON.parse(options.model);
  } catch {
    pair = null;
  }

  if (!Array.isArray(pair) || pair.length !== 2
    || pair.some((value) => typeof value !== 'string' || !value)) {
    throw modelOnlyError('model_input_invalid');
  }

  const timeout = options.timeoutMs ?? 300000;

  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900000) {
    throw modelOnlyError('model_timeout_invalid');
  }

  return timeout;
}

const PUBLIC_MODEL_ONLY_CODES = new Set([
  'unsupported_media', 'model_input_invalid', 'model_timeout_invalid', 'unsafe_model_provider',
  'deepseek_api_key_missing', 'glm_access_mode_missing', 'glm_access_mode_invalid',
  'glm_key_missing', 'glm_mode_not_admitted', 'glm_model_mismatch', 'glm_effort_mismatch',
  'glm_runtime_incompatible', 'glm_runtime_not_admitted', 'glm_runtime_missing',
]);

export type ModelOnlyDshRoute = ScopedDshRoute | ((signal: AbortSignal) => Promise<ScopedDshRoute>);
/**
 * Единственный deadline начинается до ленивой подготовки маршрута адаптером.
 * Общий metadata probe не убивается: отменяется только ожидание этого caller.
 */
export async function runModelOnlyDsh(options: ModelOnlyDshOptions, prepare: ModelOnlyDshRoute) {
  const timeout = validateModelOnlyInput(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

  try {
    const route = typeof prepare === 'function'
      ? await waitForDshOperation(prepare(signal), signal) : prepare;

    signal.throwIfAborted();

    const result = await runIsolatedDsh({
      cwd: '',
      message: options.message,
      model: options.model,
      effort: options.effort,
      signal,
      workspaceAccess: null,
    }, route, true);

    signal.throwIfAborted();

    if ('deliveryFailure' in result && result.deliveryFailure || typeof result.reply !== 'string'
      || !result.reply.trim() || result.reply.length > 131072) {
      throw modelOnlyError('model_run_failed');
    }

    return {
      reply: result.reply,
      sessionId: null,
      actualModel: result.actualModel || null,
      cost: null,
    };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    // Нельзя выбрасывать прежний Error: runner мог добавить sessionId и steps.
    throw modelOnlyError(signal.aborted ? 'model_run_aborted'
      : PUBLIC_MODEL_ONLY_CODES.has(code) ? code : 'model_run_failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Вход триажа сохраняет workspaceAccess и собственный ограниченный MCP.
 * Одноимённое поле внешних options не может переключить его в model-only профиль.
 */
export async function runScopedDsh(options: ScopedDshOptions, route: ScopedDshRoute) {
  return runIsolatedDsh(options, route, false);
}

/**
 * Единственный владелец одноразового профиля и cleanup для двух закрытых входов.
 * modelOnly задаётся только обёрткой, а не данными пользователя.
 */
async function runIsolatedDsh(options: ScopedDshOptions, route: ScopedDshRoute, modelOnly: boolean) {
  options.signal?.throwIfAborted();

  if (!options.model) {
    throw new Error('Триаж требует явный выбор модели.');
  }

  const tools = modelOnly ? null
    : await createScopedWorkspaceTools(options.workspaceAccess, options.workTools, options.signal);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-triage-dsh-'));
  let ipc: Awaited<ReturnType<typeof createWorkIpc>> | undefined;

  try {
    if (tools) {
      ipc = await createWorkIpc({ workTools: tools, root: directory });
    }

    const cwd = modelOnly ? path.join(directory, 'workspace') : options.cwd;

    if (modelOnly) {
      await fs.mkdir(cwd, { mode: 0o700 });
    }

    const home = path.join(directory, 'home');
    const profileId = modelOnly ? 'grigdesk-model-only' : 'grigdesk-triage';
    const presetRoot = path.join(directory, 'presets');
    const preset = path.join(presetRoot, profileId);
    const proofPath = path.join(directory, 'guard-proof.json');
    const guardPath = path.join(directory, 'guard.mjs');
    const overlayPath = path.join(directory, 'overlay.json');
    const nonce = randomUUID();
    const allowed = (tools?.descriptors ?? []).map((tool) => glmMcpToolName('grigdesk-work', tool.name));

    await Promise.all([fs.mkdir(home), fs.mkdir(preset, { recursive: true })]);
    await Promise.all([
      fs.writeFile(path.join(preset, 'agent.cordis.yml'), JSON.stringify(modelOnly ? [{
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: {
          prefix: 'Return the requested text. Do not use tools.',
          complete: true,
          includeRuntimeContext: false,
        },
      }] : []) + '\n', { mode: 0o600 }),
      fs.writeFile(guardPath, modelOnly ? MODEL_ONLY_GUARD : GUARD_SOURCE, { mode: 0o600 }),
      fs.writeFile(overlayPath, JSON.stringify([
        { id: 'agent-presets', config: {
          default: profileId,
          includeShippedRoot: false,
          includeUserRoot: false,
          roots: [{ path: presetRoot, trust: 'system' }],
        } },
        { id: 'session-title-llm', disabled: true },
        { id: 'agent-instructions', disabled: true },
        { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: cwd } },
        { id: 'approval', config: { policy: 'never' } },
        { id: 'permission', config: {
          defaultPreset: profileId,
          presets: { [profileId]: { sandbox: 'read-only', approval: 'never' } },
        } },
        ...(modelOnly ? [
          { id: 'llm-retry', disabled: true },
          { id: 'session-reference', disabled: true },
          { id: 'file-reference-local', disabled: true },
          // sessionPersistence нужен web controller; его журнал живёт только в одноразовом home.
          { id: 'llm-deepseek', config: { retryPolicy: { mode: 'normal', maxRetries: 0 } } },
        ] : []),
        ...(route.rows ?? []),
        { insert: [
          ...(route.insert ?? []),
          {
            id: modelOnly ? 'grigdesk-model-only-guard' : 'grigdesk-triage-guard',
            name: pathToFileURL(guardPath).href,
            config: {
              proofPath,
              nonce,
              allowed,
            },
          },
          ...(ipc ? [{
            id: 'grigdesk-triage-mcp',
            name: '@deepseek-ai/dsh-mcp-client',
            config: {
              serverName: 'grigdesk-work',
              transport: 'stdio',
              command: ipc.mcpServer.command,
              args: ipc.mcpServer.args,
              env: {},
              failOnStartupError: true,
              reconnect: { enabled: false },
            },
          }] : []),
        ] },
      ]), { mode: 0o600 }),
    ]);

    /**
     * Ни один prompt не доходит до runtime до подтверждения собственного native guard.
     * Ошибка подтверждения закрывает именно процесс этого запуска перед удалением файлов.
     */
    const start: typeof startDeepSeekServer = async (input) => {
      const server = await (route.startServer ?? startDeepSeekServer)(input);

      try {
        const deadline = Date.now() + 10_000;
        let proof: unknown;

        while (Date.now() < deadline) {
          options.signal?.throwIfAborted();
          proof = await fs.readFile(proofPath, 'utf8').then((text) => JSON.parse(text), () => null);
          options.signal?.throwIfAborted();

          if (proof) {
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        if (!isRecord(proof) || proof.nonce !== nonce
          || JSON.stringify(proof.allowed) !== JSON.stringify(allowed)) {
          if (modelOnly) {
            throw modelOnlyError('unsafe_model_provider');
          }

          throw new Error('Исполнитель не подтвердил ограниченные инструменты триажа.');
        }

        return server;
      } catch (error) {
        await server.stop();

        throw error;
      }
    };

    const pair: unknown = modelOnly ? JSON.parse(options.model!) : null;
    const variant: DeepSeekTurnVariant | undefined = modelOnly ? {
      interruptOnAbort: true,
      labels: {
        stopped: 'Model-only остановлен.',
        blocked: 'Model-only заблокирован.',
        modelError: 'Ошибка модели',
        action: 'Model-only',
        source: 'Model-only'
      },
      autoApprove: () => false,
      approve: async () => ({
        allow: false
      }),
      classifyModelError: () => modelOnlyError('model_run_failed'),
      /**
       * Любой инструмент или незавершённый turn закрывает изолированный вызов.
       * Частичный текст перед отказом никогда не превращается в успешный результат.
       */
      inspectEvent(event) {
        if (event.type === 'tool/call') {
          return modelOnlyError('unsafe_model_provider');
        }

        const data = isRecord(event.data) ? event.data : {};
        const reason = isRecord(data.reason) ? data.reason : {};

        if (event.type === 'turn/end' && reason.kind !== 'completed') {
          return modelOnlyError('model_run_failed');
        }

        return null;
      },
      /**
       * Выбор подтверждается настоящим snapshot до отправки постановки модели.
       * Несовпадение любого поля запрещает prompt без раскрытия содержимого snapshot.
       */
      verifySnapshot(snapshot) {
        const projections = isRecord(snapshot.projections) ? snapshot.projections : {};
        const values = isRecord(projections.values) ? projections.values : {};
        const selection = isRecord(values.modelSelection) ? values.modelSelection : {};
        const next = isRecord(selection.next) ? selection.next : {};

        if (!Array.isArray(pair) || pair.length !== 2 || next.provider !== pair[0]
          || next.model !== pair[1] || options.effort && next.reasoningEffort !== options.effort) {
          return modelOnlyError('unsafe_model_provider');
        }

        return null;
      },
    } : undefined;

    return await runDeepSeekServerTurn({
      cwd,
      message: options.message,
      model: options.model,
      effort: options.effort,
      signal: options.signal,
      onStep: modelOnly ? undefined : options.onStep,
      onProgress: modelOnly ? undefined : options.onProgress,
      onRunMetadata: modelOnly ? undefined : options.onRunMetadata,
      variant,
      runtime: route.runtime,
      bin: route.runtime.command,
      overlayPath,
      env: {
        ...route.childEnv(home),
        HOME: home,
        TMPDIR: directory,
        ...(modelOnly ? { GRIGDESK_HOME: home } : {}),
      },
      sessionId: null,
      permissionMode: 'auto',
      workToolNames: new Set((tools?.descriptors ?? []).map((tool) => tool.name)),
      startServer: start,
    });
  } finally {
    try {
      await ipc?.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
