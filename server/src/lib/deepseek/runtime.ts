import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChildProcess } from 'node:child_process';

import { AcpRpcError, createAcpClient, initializeAcp } from '../acp/client.ts';
import { contextCacheStatus } from '../chat/contextCache.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { buildDeepSeekChildEnv, chatHomeFor, ensurePrivateDir } from './env.ts';
import {
  resolveDeepSeekPermission,
} from './permissions.ts';
import type {
  DeepSeekPermissionAnswer,
  DeepSeekPermissionParams,
  DeepSeekToolContext,
} from './permissions.ts';
import { createDeepSeekStepNormalizer } from './steps.ts';
import type { DeepSeekUpdate } from './steps.ts';
import { DEEPSEEK_BASH_TOOL } from './contract.ts';
import { buildLaunchFiles } from './profile.ts';

interface DeepSeekConfig {
  deepseekRuntimeHome: string;
  deepseekBin: string;
  rootDir?: string;
}

interface DeepSeekMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

interface DeepSeekProviderSettings {
  blockDirectSsh?: unknown;
  blockDirectDb?: unknown;
  strictUnknownDbClient?: unknown;
}

interface RuntimeDeps {
  spawn?: typeof spawn;
  prepareLaunch?: (options: {
    config: DeepSeekConfig;
    cwd: string;
    workspaceRoot: string;
    chatKey: string;
    mode: 'read-only' | 'workspace-write';
    approval: 'ask' | 'never';
    projectRoot: string;
    providerSettings?: DeepSeekProviderSettings | null;
  }) => Promise<{ launchDir: string; dshHome: string; overlayPath: string }>;
  closeTimeoutMs?: number;
  termTimeoutMs?: number;
}

interface RuntimeLog {
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
}

function textContent(value: unknown): string {
  const content = value as { type?: unknown; text?: unknown } | null;
  return content?.type === 'text' ? String(content.text || '') : '';
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    // `close` ждёт закрытия stdio. Унаследованный tool-child может удерживать pipe
    // после смерти DSH, поэтому границей жизни процесса служит именно `exit`.
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function nearestProjectRoot(cwd: string): Promise<string> {
  let current = cwd;
  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch { /* поднимаемся к родителю */ }
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/**
 * Проверяет вложенность по каноническим путям, полученным через fs.realpath.
 * Соседний каталог с похожим префиксом не должен расширять границу записи.
 */
function containsRealPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function prepareDeepSeekLaunch({
  config,
  cwd,
  workspaceRoot,
  chatKey,
  mode,
  approval,
  projectRoot,
  providerSettings,
}: {
  config: DeepSeekConfig;
  cwd: string;
  workspaceRoot: string;
  chatKey: string;
  mode: 'read-only' | 'workspace-write';
  approval: 'ask' | 'never';
  projectRoot: string;
  providerSettings?: DeepSeekProviderSettings | null;
}) {
  const dshHome = chatHomeFor(config.deepseekRuntimeHome, chatKey);
  const chatDir = path.dirname(dshHome);
  const launchDir = path.join(chatDir, 'turns', randomUUID());
  await ensurePrivateDir(dshHome);
  const files = await buildLaunchFiles({
    launchDir,
    cwd,
    workspaceRoot,
    mode,
    approval,
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: providerSettings?.blockDirectSsh !== false,
      db: providerSettings?.blockDirectDb === true,
      strictDb: providerSettings?.strictUnknownDbClient === true,
      instructions: { projectRoot },
    },
  });
  return { ...files, dshHome };
}

function modeFor(value: unknown): 'read-only' | 'workspace-write' {
  if (value === 'read-only') return 'read-only';
  if (value === 'workspace-write' || value === 'default' || value === 'auto'
      || value === undefined || value === null) {
    return 'workspace-write';
  }
  throw new Error(`DeepSeek: неизвестный режим ${String(value)}`);
}

function validateMcpServers(value: readonly DeepSeekMcpServer[]): DeepSeekMcpServer[] {
  if (!Array.isArray(value)) throw new TypeError('DeepSeek mcpServers должен быть массивом');
  const entries = value as readonly DeepSeekMcpServer[];
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`DeepSeek mcpServers[${index}] повреждён`);
    }
    const name = String(entry.name || '');
    const command = String(entry.command || '');
    if (!name || !path.isAbsolute(command) || command.includes('\0')) {
      throw new TypeError(`DeepSeek mcpServers[${index}] требует имя и абсолютную command`);
    }
    if (!Array.isArray(entry.args)
        || entry.args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
      throw new TypeError(`DeepSeek mcpServers[${index}].args повреждён`);
    }
    if (!Array.isArray(entry.env)
        || entry.env.some((item) => !item || typeof item.name !== 'string'
          || typeof item.value !== 'string' || !item.name || item.name.includes('\0')
          || item.value.includes('\0'))) {
      throw new TypeError(`DeepSeek mcpServers[${index}].env повреждён`);
    }
    return {
      name,
      command,
      args: [...entry.args],
      env: entry.env.map((item) => ({ ...item })),
    };
  });
}

function configValues(configOptions: unknown, configId: string): string[] {
  const entries = Array.isArray(configOptions) ? configOptions as Array<{
    id?: unknown;
    options?: unknown;
  }> : [];
  const entry = entries.find((candidate) => candidate?.id === configId);
  const values: string[] = [];
  const visit = (options: unknown): void => {
    if (!Array.isArray(options)) return;
    for (const option of options as Array<{ value?: unknown; options?: unknown }>) {
      if (typeof option?.value === 'string') values.push(option.value);
      visit(option?.options);
    }
  };
  visit(entry?.options);
  return values;
}

function assertConfigValue(configOptions: unknown, configId: string, value: string): void {
  if (!value) return;
  const values = configValues(configOptions, configId);
  if (!values.length || values.includes(value)) return;
  if (configId === 'model') throw new Error(`DeepSeek: модель не поддерживается: ${value}`);
  throw new Error(`DeepSeek: effort не поддерживается: ${value}`);
}

function workToolNames(workTools: unknown): Set<string> {
  const descriptors = (workTools as { descriptors?: unknown } | null)?.descriptors;
  if (!Array.isArray(descriptors)) return new Set();
  return new Set(descriptors.map((descriptor) => {
    const value = descriptor as { name?: unknown; function?: { name?: unknown } } | null;
    return String(value?.name || value?.function?.name || '');
  }).filter(Boolean));
}

const TURN_FAILED_PREFIX = /^Internal error: turn failed: /u;

// Живой счётчик вывода. DSH расхода не публикует (ACP отдаёт только заполненность
// контекста), поэтому вывод считается по потоку: сколько символов написал агент — столько
// и делим на средний размер токена. Та же оценка, что у Ollama, и так же помеченная «≈»:
// точного числа у этого исполнителя нет вовсе, а пустое место человек читает как поломку.
const CHARS_PER_TOKEN = 3;
const PROGRESS_THROTTLE_MS = 400;

/**
 * Длина вывода модели в символах: текст сообщения или аргументы вызова инструмента.
 * Точного счётчика токенов DSH не даёт, поэтому объём потока — единственная опора для
 * оценки расхода; аргументы сериализуем, а несериализуемое честно считаем нулём.
 */
function producedCharsOf(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object') return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Ход оборвал сам harness после старта: сеть до API, 429/5xx, обрыв соединения. Ответа
 * модели не было, но сессия DSH цела — следующий prompt продолжит её. Такой исход
 * отдаётся как delivery failure (лента, id сессии, кнопка «Продолжить ход»), а не как
 * исключение. Отказ ключа — не обрыв: продолжать там нечего.
 */
function deliveryFailureText(error: unknown): string | null {
  if (!(error instanceof AcpRpcError) || error.method !== 'session/prompt') return null;
  const message = String(error.message || '');
  if (!TURN_FAILED_PREFIX.test(message) || /Authentication Fails/iu.test(message)) return null;
  return message.replace(TURN_FAILED_PREFIX, '');
}

function annotateError(error: unknown, retryState: 'pre_prompt' | 'post_prompt', code?: string) {
  const value = error instanceof Error ? error : new Error(String(error));
  Object.assign(value, { retryState, ...(code ? { code } : {}) });
  return value;
}

export async function runDeepSeekTurn({
  config,
  env = process.env,
  message = '',
  model,
  effort,
  cwd,
  sessionId,
  permissionMode,
  signal,
  onStep,
  onProgress,
  onRawUpdate,
  onSessionCreated,
  onPermission,
  onPermissionResolved,
  mcpServers = [],
  workTools,
  chatKey,
  projectRoot,
  providerSettings,
  extraDirs = [],
  attachmentPaths = [],
  factory = false,
  log,
  deps = {},
}: {
  config: DeepSeekConfig;
  env?: NodeJS.ProcessEnv;
  message?: unknown;
  model?: string;
  effort?: string;
  cwd?: string;
  sessionId?: string | null;
  permissionMode?: string;
  signal?: AbortSignal;
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRawUpdate?: (update: DeepSeekUpdate) => void;
  onSessionCreated?: (sessionId: string) => unknown | Promise<unknown>;
  onPermission?: (presentation: Record<string, unknown>) => Promise<DeepSeekPermissionAnswer>;
  onPermissionResolved?: (event: {
    params: DeepSeekPermissionParams;
    context: DeepSeekToolContext;
    outcome: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } };
  }) => void;
  mcpServers?: readonly DeepSeekMcpServer[];
  workTools?: unknown;
  chatKey?: string;
  projectRoot?: string;
  providerSettings?: DeepSeekProviderSettings | null;
  extraDirs?: readonly string[];
  attachmentPaths?: readonly string[];
  factory?: boolean;
  log?: RuntimeLog;
  deps?: RuntimeDeps;
}) {
  if (!cwd || !path.isAbsolute(cwd)) throw new TypeError('DeepSeek cwd должен быть абсолютным');
  if (!chatKey) throw new Error('DeepSeek runtime требует server-owned chatKey');
  const realCwd = await fs.realpath(cwd);
  // Недоступные каталоги не расширяют sandbox, но остаются внешними для note.
  const realExtraDirs = await Promise.all(extraDirs.map(async (dir) => {
    if (!path.isAbsolute(dir)) {
      return null;
    }
    try {
      return await fs.realpath(dir);
    } catch {
      return null;
    }
  }));
  let trustedRoot: string | null = null;
  if (!factory) {
    for (const dir of realExtraDirs) {
      if (dir && containsRealPath(dir, realCwd)
          && (!trustedRoot || containsRealPath(trustedRoot, dir))) {
        trustedRoot = dir;
      }
    }
  }
  const workspaceRoot = trustedRoot || realCwd;
  const mode = modeFor(permissionMode);
  const requestedProjectRoot = projectRoot
    ? await fs.realpath(projectRoot)
    : await nearestProjectRoot(realCwd);
  const approval = factory ? 'never' : 'ask';
  const sessionMcpServers = validateMcpServers(mcpServers);
  const launch = await (deps.prepareLaunch || prepareDeepSeekLaunch)({
    config,
    cwd: realCwd,
    workspaceRoot,
    chatKey,
    mode,
    approval,
    projectRoot: requestedProjectRoot,
    providerSettings,
  });
  const childEnv = buildDeepSeekChildEnv({ source: env, dshHome: launch.dshHome });
  const spawnProcess = deps.spawn || spawn;
  const child = spawnProcess(config.deepseekBin, ['--profile', 'acp', '--patch', launch.overlayPath], {
    cwd: launch.launchDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = waitForExit(child);
  const closeTimeoutMs = deps.closeTimeoutMs ?? 8_000;
  const termTimeoutMs = deps.termTimeoutMs ?? 2_000;
  const stepSink = createStepSink(onStep);
  const normalize = createDeepSeekStepNormalizer({ model, cwd: realCwd, mode: permissionMode || 'default' });
  const tools = new Map<string, DeepSeekToolContext>();
  const knownWorkTools = workToolNames(workTools);
  let currentSession = String(sessionId || '');
  let reply = '';
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  let retryState: 'pre_prompt' | 'post_prompt' = 'pre_prompt';
  let aborted = false;
  let stderrTail = '';
  let abortTimer: ReturnType<typeof setTimeout> | null = null;
  let producedChars = 0;
  let lastProgressAt = 0;

  /**
   * Отдаёт расход хода оценкой по потоку: DSH точного числа не публикует, но пустое
   * место человек читает как поломку. Прореживание обязательно — иначе каждый чанк
   * текста становился бы отдельным SSE-событием; заполненность контекста едет тем же
   * снимком, потому что второго канала для неё у этого исполнителя нет.
   */
  const pushProgress = () => {
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    try {
      onProgress?.(Math.round(producedChars / CHARS_PER_TOKEN), {
        tokensIsEstimate: true,
        ...(contextTokens !== undefined ? {
          contextTokens,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          contextMetric: 'deepseek-acp-usage-update',
        } : {}),
      });
    } catch { /* счётчик не роняет ход */ }
  };

  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-16 * 1024);
  });

  const client = createAcpClient(child, {
    onNotification(method, params) {
      if (method !== 'session/update') return;
      const notification = params as { update?: DeepSeekUpdate } | null;
      const update = notification?.update;
      if (!update) return;
      onRawUpdate?.(update);
      const toolCallId = String(update.toolCallId || '');
      if (toolCallId && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
        const previous = tools.get(toolCallId) || {};
        tools.set(toolCallId, {
          title: update.title ?? previous.title,
          rawInput: update.rawInput ?? previous.rawInput,
          kind: update.sessionUpdate,
        });
        // Аргументы вызова пишет модель — это её вывод. Считаем один раз на вызов:
        // подробности приходят несколькими апдейтами с тем же rawInput.
        if (previous.rawInput === undefined && update.rawInput !== undefined) {
          producedChars += producedCharsOf(update.rawInput);
          pushProgress();
        }
      }
      if (update.sessionUpdate === 'agent_message_chunk') {
        reply += textContent(update.content);
        producedChars += producedCharsOf(textContent(update.content));
        pushProgress();
      }
      if (update.sessionUpdate === 'usage_update') {
        const used = Number(update.used);
        const size = Number(update.size);
        if (Number.isFinite(used) && used >= 0) contextTokens = used;
        if (Number.isFinite(size) && size > 0) contextWindow = size;
        if (contextTokens !== undefined) {
          // Первым аргументом идёт РАСХОД хода (оценка вывода), вторым — заполненность
          // контекста: она живёт в кольце и выдавать её за потраченное нельзя.
          lastProgressAt = Date.now();
          onProgress?.(Math.round(producedChars / CHARS_PER_TOKEN), {
            tokensIsEstimate: true,
            contextTokens,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
            contextMetric: 'deepseek-acp-usage-update',
          });
        }
      }
      stepSink.emitAll(normalize(notification));
    },
    async onReverseRequest(method, value) {
      if (method !== 'session/request_permission') {
        throw new Error(`Неизвестный reverse method: ${method}`);
      }
      const params = value as DeepSeekPermissionParams;
      const context = tools.get(String(params?.toolCall?.toolCallId || '')) || {};
      const outcome = await resolveDeepSeekPermission({
        params,
        context,
        mode,
        factory,
        workToolNames: knownWorkTools,
        onPermission,
        cancelled: () => aborted,
      });
      onPermissionResolved?.({ params, context, outcome });
      return outcome;
    },
  });

  const abort = () => {
    if (aborted) return;
    aborted = true;
    if (currentSession) {
      try { client.notify('session/cancel', { sessionId: currentSession }); } catch { /* уже закрыт */ }
    }
    abortTimer = setTimeout(() => child.kill('SIGTERM'), 1_500);
    abortTimer.unref?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  const shutdown = async () => {
    if (abortTimer) clearTimeout(abortTimer);
    // Хвост размышления, за которым не последовало действия, иначе пропал бы с ходом.
    try { stepSink.emitAll(normalize.flush()); } catch { /* лента не роняет ход */ }
    if (currentSession && !client.closed) {
      await client.request('session/close', { sessionId: currentSession }, 5_000).catch(() => {});
    }
    client.close();
    let ended = await Promise.race([
      exit,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), closeTimeoutMs)),
    ]);
    if (!ended) {
      child.kill('SIGTERM');
      ended = await Promise.race([
        exit,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), termTimeoutMs)),
      ]);
    }
    if (!ended) {
      child.kill('SIGKILL');
      await exit;
    }
  };

  try {
    await initializeAcp(client, 10_000);
    let configOptions: unknown = [];
    if (currentSession) {
      try {
        const resumed = await client.request('session/resume', {
          sessionId: currentSession,
          cwd: realCwd,
          mcpServers: sessionMcpServers,
        }, 30_000) as { configOptions?: unknown } | null;
        configOptions = resumed?.configOptions;
      } catch (error) {
        throw annotateError(error, 'pre_prompt', 'deepseek_session_resume_failed');
      }
    } else {
      const created = await client.request('session/new', {
        cwd: realCwd,
        mcpServers: sessionMcpServers,
      }, 30_000) as {
        sessionId?: unknown;
      } | null;
      currentSession = String(created?.sessionId || '');
      configOptions = (created as { configOptions?: unknown } | null)?.configOptions;
      if (!currentSession) throw new Error('DeepSeek ACP не вернул sessionId');
    }

    await onSessionCreated?.(currentSession);
    assertConfigValue(configOptions, 'model', String(model || ''));
    assertConfigValue(configOptions, 'reasoning_effort', String(effort || ''));
    if (model) {
      await client.request('session/set_config_option', {
        sessionId: currentSession, configId: 'model', value: model,
      }, 15_000);
    }
    if (effort) {
      await client.request('session/set_config_option', {
        sessionId: currentSession, configId: 'reasoning_effort', value: effort,
      }, 15_000);
    }

    // Граница записи — ближайший доверенный предок cwd, а в Factory ровно cwd.
    // Вложения и каталоги вне границы доступны для чтения, но не для записи.
    // Доверенные каталоги — постоянная настройка: note о внешних достаточно
    // показать однажды. Вложения — разовые, о них предупреждаем каждый ход.
    const ignored: string[] = [];
    if (attachmentPaths.length) ignored.push('вложения');
    if (!sessionId && realExtraDirs.some((dir) => !dir || !containsRealPath(workspaceRoot, dir))) {
      ignored.push('дополнительные каталоги (доверенные и worktree)');
    }
    if (ignored.length) {
      stepSink.emit({
        k: 'note', level: 'warn',
        text: `DeepSeek V1 пишет только в рабочей области ${workspaceRoot}: `
          + `${ignored.join(' и ')} не добавлены в рабочую область`,
      });
    }
    const prompt = client.request('session/prompt', {
      sessionId: currentSession,
      prompt: [{ type: 'text', text: String(message || '') }],
    });
    retryState = 'post_prompt';
    let result: { stopReason?: unknown } | null;
    try {
      result = await prompt as { stopReason?: unknown } | null;
    } catch (error) {
      const cut = deliveryFailureText(error);
      if (cut === null) throw error;
      await shutdown();
      return {
        reply: cut,
        deliveryFailure: true,
        sessionId: currentSession,
        ...(contextTokens !== undefined ? { contextTokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        contextMetric: contextTokens !== undefined ? 'deepseek-acp-usage-update' : 'unavailable',
        contextCache: contextCacheStatus('unavailable'),
        steps: stepSink.steps,
        retryState,
        stopReason: 'error',
      };
    }
    if (result?.stopReason === 'cancelled') aborted = true;

    await shutdown();
    return {
      reply,
      sessionId: currentSession,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      contextMetric: contextTokens !== undefined ? 'deepseek-acp-usage-update' : 'unavailable',
      contextCache: contextCacheStatus('unavailable'),
      steps: stepSink.steps,
      ...(reply ? {} : { emptyRun: true }),
      retryState,
      stopReason: result?.stopReason,
    };
  } catch (error) {
    await shutdown().catch(() => {});
    log?.error?.({ reason: String((error as Error)?.message || error), stderr: stderrTail }, 'DeepSeek turn failed');
    if ((error as { retryState?: unknown })?.retryState) throw error;
    throw annotateError(error, retryState);
  } finally {
    signal?.removeEventListener('abort', abort);
    // Overlay и hooks хода нужны только живому процессу: после shutdown каталог хода
    // становится мусором, который иначе копился бы по одному на каждое сообщение.
    await fs.rm(launch.launchDir, { recursive: true, force: true }).catch(() => {});
  }
}
