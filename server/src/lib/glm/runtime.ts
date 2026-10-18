import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { spawn } from 'node:child_process';

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import type { InTurnAssistantEvent, InTurnPort } from '../../../../shared/chat/chatInTurnContracts.ts';
import type { ChatRunMetadata } from '../../../../shared/chat/chatRun.ts';
import { contextCacheStatus } from '../chat/contextCache.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { nearestProjectRoot } from '../deepseek/projectMcp.ts';
import { resolveDeepSeekRuntimeAsync } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import { DeepSeekWebError } from '../deepseek/serverClient.ts';
import { runDeepSeekServerTurn } from '../deepseek/serverTurn.ts';
import type { DeepSeekTurnVariant } from '../deepseek/serverTurn.ts';
import {
  GLM_DEFAULT_EFFORT,
  GLM_MODEL_ERROR_CODES,
  GLM_MODEL_UNAVAILABLE,
  glmCompatibilityIdentity,
} from './contract.ts';
import type { GlmAccessMode } from './contract.ts';
import { assertGlmRuntimeHome, buildGlmChildEnv, glmAccessError, resolveGlmAccess } from './env.ts';
import { describeGlmGeneration } from './generation.ts';
import { glmChatHome, prepareGlmLaunch, startGlmProcess } from './launch.ts';
import { createGlmTurnGuard } from './permissions.ts';
import { assertGlmSessionJournal, isGlmSessionCorrupt } from './session.ts';

type PermissionAnswer = {
  allow?: boolean;
  rawAnswers?: Array<{ selected?: string[]; text?: string }>;
};

export interface GlmCatalogModel {
  id: string;
  efforts?: readonly string[];
}

export interface GlmRuntimeDeps {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  admission: readonly { mode: GlmAccessMode; compatibility: string }[];
  catalog?: readonly GlmCatalogModel[];
  // Только тестовая подмена (Р16): адрес фейковой модели, сторож fetch и запуск процесса.
  modelEndpoint?: string;
  egressGuard?: string;
  spawn?: typeof spawn;
}

export interface GlmTurnOptions {
  config: DeepSeekRuntimeConfig & { glmRuntimeHome?: string };
  message?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  chatKey?: string;
  sessionId?: string | null;
  permissionMode?: string;
  signal?: AbortSignal;
  factory?: boolean;
  workspaceAccess?: unknown;
  untrustedInput?: unknown;
  scopedWorkspace?: unknown;
  providerSettings?: Record<string, unknown> | null;
  mcpServers?: readonly {
    name: string;
    command: string;
    args: readonly string[];
    env: readonly { name: string; value: string }[];
  }[];
  workTools?: unknown;
  attachmentPaths?: readonly string[];
  extraDirs?: readonly string[];
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  onPermission?: (presentation: Record<string, unknown>) => Promise<PermissionAnswer | null | undefined>;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: 'not_ready' | 'awaiting_answer' }) => void;
  log?: { warn?: (value: unknown, message?: string) => void };
}

export const GLM_AMBIGUOUS_MESSAGE = 'Связь с GLM оборвалась после отправки. '
  + 'Действие могло выполниться; автоматического повтора не было.';

const LABELS: DeepSeekTurnVariant['labels'] = Object.freeze({
  stopped: 'Ход GLM остановлен.',
  blocked: 'Ход GLM заблокирован.',
  modelError: 'Ошибка модели GLM',
  action: 'Действие GLM',
  source: 'GLM',
});

const MODEL_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  glm_auth_failed: 'Z.ai отклонил ключ GLM. Проверь ключ режима в окружении службы.',
  glm_quota_exhausted: 'Квота или баланс Z.ai исчерпаны. Ход не повторялся.',
});

/**
 * Режим чата GLM: пустой и отсутствующий — «Правки в проекте»; остальные отказ.
 * Общий allowedMode уже превратил неизвестное значение в пустую строку.
 */
function chatMode(value: unknown): 'default' | 'auto' {
  if (value === undefined || value === null || value === '' || value === 'default') {
    return 'default';
  }

  if (value === 'auto') {
    return 'auto';
  }

  throw glmAccessError('glm_mode_unsupported', 'Этот режим прав GLM не поддерживает.');
}

/**
 * id модели — JSON-пара ["zai", "<модель>"], как в каталоге; другой маршрут — отказ.
 * Разбор не бросает исключений: некорректный id даёт тот же код несовпадения модели.
 */
function modelPair(value: unknown): string | null {
  try {
    const pair = JSON.parse(String(value ?? ''));

    return Array.isArray(pair) && pair.length === 2 && pair[0] === 'zai'
      && typeof pair[1] === 'string' && pair[1] ? pair[1] : null;
  } catch {
    return null;
  }
}

function hasToolSteps(steps: readonly ChatStep[]): boolean {
  return steps.some((step) => step.k === 'tool' || step.k === 'res');
}

/**
 * Предполётная проверка до любого процесса: потребитель, режим, доступ, модель и effort.
 * Возвращает выбранные значения; любой отказ — ошибка с публичным кодом glm_*.
 */
function preflight(options: GlmTurnOptions, deps: GlmRuntimeDeps) {
  if (options.factory || options.workspaceAccess || options.untrustedInput || options.scopedWorkspace) {
    throw glmAccessError('glm_consumer_unsupported', 'GLM работает только в обычном чате.');
  }

  if (!options.chatKey || !options.onSessionCreated) {
    throw glmAccessError('glm_consumer_unsupported', 'GLM требует server-owned chatKey и привязку сессии.');
  }

  const mode = chatMode(options.permissionMode);
  const access = resolveGlmAccess({ env: deps.env, admission: deps.admission });

  if (access.reason || !access.mode) {
    throw glmAccessError(access.reason || 'glm_access_mode_missing', 'GLM недоступен: проверь карточку.');
  }

  const model = modelPair(options.model);
  // Каталог адаптера — сам DSH: без списка в зависимостях принадлежность модели и уровня
  // подтверждает session/selectModel до prompt (отказ — session/model-unavailable).
  const entry = deps.catalog?.find((item) => item.id === options.model);

  if (!model || (deps.catalog && !entry)) {
    throw glmAccessError('glm_model_mismatch', 'Модель не из каталога GLM.');
  }

  const effort = options.effort || GLM_DEFAULT_EFFORT;

  if (entry?.efforts?.length && !entry.efforts.includes(effort)) {
    throw glmAccessError('glm_effort_mismatch', 'Уровень рассуждения не поддерживается моделью GLM.');
  }

  if (!options.cwd || !path.isAbsolute(options.cwd)) {
    throw new TypeError('GLM cwd должен быть абсолютным');
  }

  return {
    mode,
    accessMode: access.mode,
    model,
    effort,
  };
}

/**
 * Перевод ошибки хода в таблицу исходов Р6. Отказ привязки чата и собственные коды
 * glm_* проходят как есть; до prompt — сбой запуска, после prompt — неясный исход.
 */
function turnFailure(error: unknown, state: { promptAttempted: boolean; bindingError: unknown }): Error {
  if (error === state.bindingError) {
    return error as Error;
  }

  const failure = error as Error & {
    code?: string;
    stopped?: boolean;
    sessionId?: string;
    steps?: unknown;
  };
  const carried = {
    ...(failure?.sessionId ? { sessionId: failure.sessionId } : {}),
    ...(failure?.steps ? { steps: failure.steps } : {}),
  };

  if (failure?.stopped || String(failure?.code || '').startsWith('glm_')) {
    return Object.assign(failure, carried);
  }

  const unavailable = failure instanceof DeepSeekWebError && failure.code === GLM_MODEL_UNAVAILABLE;

  if (!state.promptAttempted && failure instanceof DeepSeekWebError && isGlmSessionCorrupt(failure.message)) {
    return glmAccessError('glm_session_missing', 'Журнал сессии GLM повреждён; сбрось память чата.');
  }

  if (!state.promptAttempted && unavailable) {
    const effort = /reasoning effort/iu.test(failure.message);

    return glmAccessError(effort ? 'glm_effort_mismatch' : 'glm_model_mismatch',
      effort ? 'Уровень рассуждения не принят GLM.' : 'Модель не принята GLM.');
  }

  if (!state.promptAttempted) {
    return glmAccessError('glm_runtime_start_failed', 'GLM не запустился до отправки сообщения.');
  }

  return Object.assign(glmAccessError('glm_ambiguous_outcome', GLM_AMBIGUOUS_MESSAGE), carried);
}

/**
 * Один ход GLM: предполётная проверка, закрепление generation и identity допуска,
 * подготовка запуска и параметризованный web-ход DSH. Повторов нет ни на каком слое.
 */
export async function runGlmTurn(options: GlmTurnOptions, deps: GlmRuntimeDeps) {
  const selected = preflight(options, deps);

  if (options.signal?.aborted) {
    throw Object.assign(new Error(LABELS.stopped), { stopped: true });
  }

  const config = { ...options.config, deepseekRuntimeMode: 'embedded' as const };
  const runtime = await resolveDeepSeekRuntimeAsync(config).catch(() => {
    throw glmAccessError('glm_runtime_missing', 'Встроенная сборка DSH недоступна.');
  });
  const generation = describeGlmGeneration(config);

  if (generation.buildId !== runtime.buildId) {
    throw glmAccessError('glm_runtime_start_failed', 'Сборка DSH сменилась во время подготовки хода.');
  }

  const identity = glmCompatibilityIdentity(generation.runtime, selected.accessMode);

  const admitted = deps.admission.some((entry) => entry.mode === selected.accessMode
    && entry.compatibility === identity);

  if (!admitted) {
    throw glmAccessError('glm_runtime_not_admitted', 'Эта сборка DSH не прошла допуск GLM.');
  }

  const cwd = await fs.realpath(options.cwd!);
  const home = glmChatHome(assertGlmRuntimeHome(String(options.config.glmRuntimeHome ?? '')), identity,
    options.chatKey!);

  if (options.sessionId) {
    await assertGlmSessionJournal(home, cwd, options.sessionId);
  }

  const descriptors = (options.workTools as { descriptors?: unknown } | null)?.descriptors;
  const workTools = (Array.isArray(descriptors) ? descriptors : [])
    .map((entry) => String(
      recordOrEmpty(entry).name || recordOrEmpty(recordOrEmpty(entry).function).name || ''
    ))
    .filter(Boolean);
  const settings = options.providerSettings ?? {};
  const launch = await prepareGlmLaunch({
    runtimeHome: assertGlmRuntimeHome(String(options.config.glmRuntimeHome ?? '')),
    identity,
    chatKey: options.chatKey!,
    cwd,
    workspaceRoot: cwd,
    projectRoot: await nearestProjectRoot(cwd),
    accessMode: selected.accessMode,
    model: selected.model,
    transport: 'web',
    hooks: {
      ssh: settings.blockDirectSsh !== false,
      db: settings.blockDirectDb === true,
      strictDb: settings.strictUnknownDbClient === true,
    },
    mcpServers: options.mcpServers,
    workTools,
    modelEndpoint: deps.modelEndpoint,
    egressGuard: deps.egressGuard,
    warn: (message) => options.log?.warn?.({ chatKey: options.chatKey }, message),
  });
  const env = buildGlmChildEnv({
    source: deps.env,
    dshHome: launch.dshHome,
    mode: selected.accessMode,
  });
  const state = {
    promptAttempted: false,
    bindingError: null as unknown,
  };
  const expected = {
    provider: 'zai',
    model: selected.model,
    reasoningEffort: selected.effort,
  };
  const guard = createGlmTurnGuard({ workTools, signal: options.signal });
  const ignored = [
    ...(options.attachmentPaths?.length ? ['вложения'] : []),
    ...(options.extraDirs?.length ? ['дополнительные каталоги'] : []),
  ];

  // Граница записи GLM — только рабочая папка: вложения и прочие корни в неё не добавляются.
  if (ignored.length) {
    options.onStep?.({
      k: 'note',
      level: 'warn',
      text: `GLM пишет только в рабочей папке ${cwd}: ${ignored.join(' и ')} не добавлены в рабочую область`,
    } as ChatStep);
  }

  let result: Awaited<ReturnType<typeof runDeepSeekServerTurn>>;

  try {
    result = await runDeepSeekServerTurn({
      runtime,
      bin: runtime.command,
      overlayPath: launch.overlayPath,
      cwd,
      env,
      message: String(options.message || ''),
      sessionId: options.sessionId,
      model: options.model,
      effort: selected.effort,
      signal: options.signal,
      onStep: options.onStep,
      onProgress: options.onProgress,
      onRunMetadata: options.onRunMetadata,
      onAssistantMessage: options.onAssistantMessage,
      onInTurnReady: options.onInTurnReady,
      onInTurnAvailability: options.onInTurnAvailability,
      /**
       * Отказ CAS привязки чата — не сбой GLM: он возвращается вызывающему как есть,
       * а prompt после него не отправляется.
       */
      onSessionCreated: async (sessionId) => {
        try {
          await options.onSessionCreated?.(sessionId);
        } catch (error) {
          state.bindingError = error;

          throw error;
        }
      },
      onPermission: options.onPermission,
      permissionMode: options.permissionMode,
      onPromptAttempted: () => {
        state.promptAttempted = true;
      },
      startServer: () => startGlmProcess({
        runtime,
        launch,
        cwd,
        env,
        signal: options.signal,
        spawnProcess: deps.spawn,
      }),
      variant: {
        labels: LABELS,
        classifyModelError: (failure) => {
          const code = GLM_MODEL_ERROR_CODES[String(failure.code || '')];

          return code ? glmAccessError(code, MODEL_ERROR_MESSAGES[code]!) : null;
        },
        verifySnapshot: (snapshot) => {
          const next = recordOrEmpty(
            recordOrEmpty(recordOrEmpty(recordOrEmpty(snapshot.projections).values).modelSelection).next
          );

          if (next.provider !== expected.provider || next.model !== expected.model) {
            return glmAccessError('glm_model_mismatch', 'GLM подтвердил другую модель.');
          }

          return next.reasoningEffort === expected.reasoningEffort ? null
            : glmAccessError('glm_effort_mismatch', 'GLM подтвердил другой уровень рассуждения.');
        },
        autoApprove: guard.autoApprove,
        inspectEvent: guard.inspect,
        approve: guard.approve,
        settle: guard.settle,
        // Блокировка — определённый исход: DSH отказал до модели, повтора и эффекта нет.
        blocked: () => glmAccessError('glm_turn_blocked', 'Политика GrigDesk заблокировала ход GLM.'),
      },
    });
  } catch (error) {
    throw turnFailure(error, state);
  } finally {
    await fs.rm(launch.launchDir, { recursive: true, force: true }).catch(() => {});
  }

  const steps = result.steps as ChatStep[];
  const { emptyRun, ...rest } = result as typeof result & { emptyRun?: boolean };
  // Пустой ход — только без текста и без шагов инструментов: иначе эффект уже был.
  const empty = Boolean(emptyRun) && !hasToolSteps(steps);

  return {
    ...rest,
    ...(empty ? { emptyRun: true, retryState: 'post_prompt' } : {}),
    contextMetric: 'unavailable',
    contextCache: contextCacheStatus('unavailable'),
  };
}
