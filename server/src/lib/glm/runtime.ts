import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { spawn } from 'node:child_process';

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import type { InTurnAssistantEvent, InTurnPort } from '../../../../shared/chat/chatInTurnContracts.ts';
import type { ChatRunMetadata } from '../../../../shared/chat/chatRun.ts';
import { contextCacheStatus } from '../chat/contextCache.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { nearestProjectRoot } from '../deepseek/projectMcp.ts';
import { inspectSessionJournal } from '../deepseek/journal.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import type { PreparedExecutorRuntime } from '../executorSettings/types.ts';
import { createGlmTreeObserver } from './treeObserver.ts';
import { preparedGlmRuntime } from './preparedRuntime.ts';
import { DeepSeekWebError } from '../deepseek/serverClient.ts';
import { runDeepSeekServerTurn } from '../deepseek/serverTurn.ts';
import type { DeepSeekTurnVariant } from '../deepseek/serverTurn.ts';
import {
  GLM_DEFAULT_EFFORT,
  GLM_MODEL_UNAVAILABLE,
} from './contract.ts';
import type { GlmAccessMode } from './contract.ts';
import { assertGlmRuntimeHome, buildGlmChildEnv, glmAccessError, resolveGlmAccess } from './env.ts';
import { classifyGlmModelError } from './modelErrors.ts';
import { assertGlmFactoryContext } from './factoryContext.ts';
import type { GlmFactoryTurnContext } from './factoryContext.ts';
import { GLM_FACTORY_STATUS_SERVER, GLM_FACTORY_STATUS_TOOLS, glmFactoryPolicy } from './factoryPolicy.ts';
import { assertGlmGenerationAdmission, describeGlmGenerationAsync, glmRuntimeConfig } from './generation.ts';
import { adoptLegacyGlmHome, glmChatHome, prepareGlmLaunch, startGlmProcess } from './launch.ts';
import { createGlmTurnGuard } from './permissions.ts';
import { runScopedGlmTurn } from './scopedTurn.ts';
import { assertGlmSessionJournal, glmSessionJournalDir, isGlmSessionCorrupt } from './session.ts';

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
  admission?: readonly { mode: GlmAccessMode; compatibility: string }[];
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
  preparedRuntime?: PreparedExecutorRuntime;
  factory?: boolean;
  // Контекст отвязанного этапа от host-wrapper; без него factory=true отвергается.
  factoryContext?: GlmFactoryTurnContext;
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
 * Этап фабрики принимается только с typed context хоста: свежая сессия, единственный
 * статусный MCP из контекста и файловый режим узла. Чатовые режимы прав сюда не входят.
 */
function factoryPreflight(options: GlmTurnOptions) {
  const factory = assertGlmFactoryContext(options.factoryContext);
  const policy = glmFactoryPolicy(factory.filesystem);

  if (options.sessionId || options.mcpServers?.length) {
    throw glmAccessError('glm_factory_context_invalid', 'Этап GLM начинает свою сессию без чужих MCP.');
  }

  if (options.permissionMode !== undefined && options.permissionMode !== policy.mode) {
    throw glmAccessError('glm_mode_unsupported', 'Режим прав этапа GLM задаёт только контекст хоста.');
  }

  return {
    context: factory,
    policy,
  };
}

/**
 * Предполётная проверка до любого процесса: потребитель, режим, доступ, модель и effort.
 * Возвращает выбранные значения; любой отказ — ошибка с публичным кодом glm_*.
 */
function preflight(options: GlmTurnOptions, deps: GlmRuntimeDeps) {
  if (options.workspaceAccess || options.untrustedInput || options.scopedWorkspace
    || Boolean(options.factory) !== (options.factoryContext !== undefined)) {
    throw glmAccessError('glm_consumer_unsupported', 'GLM работает только в обычном чате и этапе фабрики.');
  }

  if (!options.chatKey || !options.onSessionCreated) {
    throw glmAccessError('glm_consumer_unsupported', 'GLM требует server-owned chatKey и привязку сессии.');
  }

  const factory = options.factory ? factoryPreflight(options) : null;
  const mode = factory ? null : chatMode(options.permissionMode);
  const access = resolveGlmAccess({ env: deps.env, admission: deps.admission });

  if (access.reason || !access.mode) {
    throw glmAccessError(access.reason || 'glm_access_mode_missing', 'GLM недоступен: проверь карточку.');
  }

  // Этап фабрики идёт в режиме службы (api или coding-plan — policy-v2, решение владельца
  // 29.10.2026): ключ режима подставляет buildGlmChildEnv, допуск сверяет resolveGlmAccess
  // по metadata DSH. Отдельной привязки этапа к «только api» больше нет.

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
    factory,
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

  if (failure?.stopped || failure?.code === 'deepseek_binary_cleanup'
    || String(failure?.code || '').startsWith('glm_')) {
    return Object.assign(failure, carried);
  }

  const unavailable = failure instanceof DeepSeekWebError && failure.code === GLM_MODEL_UNAVAILABLE;

  if (!state.promptAttempted && failure instanceof DeepSeekWebError && isGlmSessionCorrupt(failure.message)) {
    return Object.assign(glmAccessError('glm_session_missing',
      'Журнал сессии GLM повреждён; сбрось память чата.'), { cause: failure });
  }

  if (!state.promptAttempted && unavailable) {
    const effort = /reasoning effort/iu.test(failure.message);

    return glmAccessError(effort ? 'glm_effort_mismatch' : 'glm_model_mismatch',
      effort ? 'Уровень рассуждения не принят GLM.' : 'Модель не принята GLM.');
  }

  if (!state.promptAttempted) {
    return glmAccessError('glm_runtime_start_failed', 'GLM не запустился до отправки сообщения.');
  }

  return Object.assign(glmAccessError('glm_ambiguous_outcome', GLM_AMBIGUOUS_MESSAGE), {
    ...carried,
    cause: failure,
  });
}

/**
 * Один ход GLM: предполётная проверка, закрепление generation и identity допуска,
 * подготовка запуска и параметризованный web-ход DSH. Повторов нет ни на каком слое.
 */
export async function runGlmTurn(options: GlmTurnOptions, deps: GlmRuntimeDeps) {
  if (options.workspaceAccess && !options.factory && !options.untrustedInput && !options.scopedWorkspace) {
    return runScopedGlmTurn(options, deps);
  }

  const selected = preflight(options, deps);

  if (options.signal?.aborted) {
    throw Object.assign(new Error(LABELS.stopped), { stopped: true });
  }

  const config = glmRuntimeConfig(options.config);
  const runtime = await preparedGlmRuntime(config, options.preparedRuntime).catch((error) => {
    if ((error as { code?: string }).code === 'glm_runtime_changed') {
      throw error;
    }

    throw glmAccessError('glm_runtime_missing', 'Встроенная сборка DSH недоступна.');
  });
  const generation = await describeGlmGenerationAsync(config, runtime);

  if (!selected.factory && runtime.metadata?.capabilities.glmNativeGate !== true) {
    throw glmAccessError('glm_policy_gate_missing', 'В поставке GLM нет обязательного native gate.');
  }

  if (generation.buildId !== runtime.buildId) {
    throw glmAccessError('glm_runtime_start_failed', 'Сборка DSH сменилась во время подготовки хода.');
  }

  const identity = assertGlmGenerationAdmission(generation, selected.accessMode, deps.admission);

  // STATE_DIR — единственный workspace проверяющего узла. Рабочие деревья читаются
  // по абсолютным путям, а native write/edit и shell остаются в одной песочнице DSH.
  const factory = selected.factory;
  const cwd = await fs.realpath(factory?.context.filesystem === 'state-only'
    ? factory.context.stateDir! : options.cwd!);
  const runtimeHome = assertGlmRuntimeHome(String(options.config.glmRuntimeHome ?? ''));
  const home = runtime.kind === 'binary' ? glmChatHome(runtimeHome, options.chatKey!)
    : glmChatHome(runtimeHome, identity, options.chatKey!);
  let sessionId = options.sessionId;
  let journalNote: ChatStep | undefined;

  // У этапа home живёт в RUN_DIR попытки: прежних chat homes для переноса у него нет.
  if (runtime.kind === 'binary' && !factory) {
    await adoptLegacyGlmHome(runtimeHome, identity, options.chatKey!);
  }

  if (sessionId && runtime.kind === 'binary') {
    glmSessionJournalDir(home, cwd, sessionId);

    const journal = await inspectSessionJournal(home, cwd, sessionId, runtime.metadata!.journal.read);

    if (journal.state === 'missing') {
      throw glmAccessError('glm_session_missing', 'Журнал сессии GLM не найден; сбрось память чата.');
    }
    if (journal.state === 'incompatible') {
      sessionId = null;
      journalNote = {
        k: 'note',
        text: 'Память исполнителя начата заново: формат журнала несовместим.',
        at: Date.now(),
      };
      options.onStep?.(journalNote);
    }
  } else if (sessionId) {
    await assertGlmSessionJournal(home, cwd, sessionId);
  }

  const descriptors = factory ? [] : (options.workTools as { descriptors?: unknown } | null)?.descriptors;
  const workTools = (Array.isArray(descriptors) ? descriptors : [])
    .map((entry) => String(
      recordOrEmpty(entry).name || recordOrEmpty(recordOrEmpty(entry).function).name || ''
    ))
    .filter(Boolean);
  const settings = options.providerSettings ?? {};
  const launch = await prepareGlmLaunch({
    runtimeHome: assertGlmRuntimeHome(String(options.config.glmRuntimeHome ?? '')),
    identity,
    homeLayout: runtime.kind === 'binary' ? 'stable' : 'legacy',
    chatKey: options.chatKey!,
    cwd,
    workspaceRoot: cwd,
    projectRoot: await nearestProjectRoot(cwd),
    accessMode: selected.accessMode,
    model: selected.model,
    transport: 'web',
    // Этап не читает чатовые тумблеры: прямые SSH и клиенты БД закрыты строгой политикой.
    hooks: factory ? {
      ssh: true,
      db: true,
      strictDb: true,
    } : {
      ssh: settings.blockDirectSsh !== false,
      db: settings.blockDirectDb === true,
      strictDb: settings.strictUnknownDbClient === true,
    },
    mcpServers: factory ? [factory.context.statusServer] : options.mcpServers,
    ...(factory ? {
      factory: { filesystem: factory.context.filesystem },
      hostServer: GLM_FACTORY_STATUS_SERVER,
    } : {}),
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
  // MCP mount, hook и сторож хода используют один точный inventory этапа.
  const guard = createGlmTurnGuard({
    workTools,
    signal: options.signal,
    ...(factory ? {
      rawMcpTools: GLM_FACTORY_STATUS_TOOLS,
      hostServer: GLM_FACTORY_STATUS_SERVER,
    } : {}),
  });
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
  let cleanupFailed = false;

  try {
    result = await runDeepSeekServerTurn({
      runtime,
      bin: runtime.command,
      overlayPath: launch.overlayPath,
      cwd,
      env,
      message: String(options.message || ''),
      sessionId,
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
      // Отвязанный этап не ждёт человека: вопрос и approval получают отказ сразу.
      onPermission: factory ? async () => ({ allow: false }) : options.onPermission,
      permissionMode: factory ? factory.policy.mode : options.permissionMode,
      factory: Boolean(factory),
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
        ...(factory ? { hostServer: GLM_FACTORY_STATUS_SERVER } : {}),
      }),
      variant: {
        labels: LABELS,
        ...(launch.nativeGate ? {
          createObserver: (context) => createGlmTreeObserver({
            ...context,
            ...launch.nativeGate!,
            workTools,
          }),
        } : {}),
        classifyModelError: classifyGlmModelError,
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
        inspectEvent: launch.nativeGate ? undefined : guard.inspect,
        approve: guard.approve,
        settle: guard.settle,
        // Блокировка — определённый исход: DSH отказал до модели, повтора и эффекта нет.
        blocked: () => glmAccessError('glm_turn_blocked', 'Политика GrigDesk заблокировала ход GLM.'),
      },
    });
  } catch (error) {
    cleanupFailed = (error as { code?: unknown }).code === 'deepseek_binary_cleanup';

    throw turnFailure(error, state);
  } finally {
    if (!cleanupFailed) {
      await fs.rm(launch.launchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const steps = result.steps as ChatStep[];
  const { emptyRun, ...rest } = result as typeof result & { emptyRun?: boolean };
  // Пустой ход — только без текста и без шагов инструментов: иначе эффект уже был.
  const empty = Boolean(emptyRun) && !hasToolSteps(steps);

  return {
    ...rest,
    ...(journalNote ? {
      reply: `${journalNote.text}\n\n${result.reply || ''}`,
      steps: [journalNote, ...steps],
    } : {}),
    ...(empty ? { emptyRun: true, retryState: 'post_prompt' } : {}),
    contextCache: contextCacheStatus('unavailable'),
  };
}
