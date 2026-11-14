import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExecutorRunInput, ExecutorRunResult } from '../executors/index.ts';
import { createStepSink, type ChatStep } from '../chat/streamSteps.ts';
import { validateWorkdirPath } from '../chat/workdir.ts';
import { redactRunnerError } from '../factoryProviderRunner.ts';
import { AcpRpcError } from '../acp/client.ts';
import { qwenConfig, qwenHostEnabled } from './settings.ts';
import { resolveQwenSnapshot } from './discovery.ts';
import { openQwenTransport, record } from './transport.ts';
import { qwenEffortOption, qwenSelectedModel } from './modelMetadata.ts';
import { createQwenTextSteps } from './steps.ts';
import { createQwenUsage } from './usage.ts';
import { resolveQwenWorkspace } from './workspace.ts';
import { resolveQwenSessionHome } from './session.ts';
import { qwenToolAllowed } from './policy.ts';
import { qwenPermissionResponse } from './permissions.ts';
import { createQwenInTurn } from './inTurn.ts';
import { qwenPromptContent, readQwenImages } from './images.ts';
import type { QwenMcpServer } from './sandbox.ts';

export interface QwenRuntimeDependencies {
  openTransport?: typeof openQwenTransport;
}

/**
 * Отмена на любой стадии подготовки сохраняет общий контракт остановки чата.
 * Ошибки CLI без отмены остаются ошибками и сохраняют исходную причину.
 */
export async function runQwenTurn(
  input: ExecutorRunInput, dependencies: QwenRuntimeDependencies = {},
): Promise<ExecutorRunResult> {
  try {
    if (!input.factory && qwenHostEnabled(input.providerSettings) && !dependencies.openTransport) {
      throw Object.assign(new Error('Qwen: режим «Хост» требует живых сессий чата.'), {
        code: 'host_persistent_required',
      });
    }

    return await runQwenSession(input, dependencies.openTransport || openQwenTransport);
  } catch (error) {
    if (input.signal?.aborted) {
      throw Object.assign(new Error('Qwen: ход отменён'), {
        stopped: true,
        sessionId: record(error).sessionId || input.sessionId || null,
        steps: record(error).steps || [],
      });
    }

    throw error;
  }
}

/**
 * Сессия принадлежит конкретным cwd, чату и снимку авторизации.
 * Внешний sessionId не назначает путь к durable home и проверяется до запуска CLI.
 */
async function runQwenSession(
  input: ExecutorRunInput, openTransport: typeof openQwenTransport,
): Promise<ExecutorRunResult> {
  input.signal?.throwIfAborted();

  const attachmentsDir = typeof input.attachmentsDir === 'string' ? input.attachmentsDir : undefined;
  const imageContent = await readQwenImages(
    Array.isArray(input.attachmentPaths) ? input.attachmentPaths : [], attachmentsDir, input.signal,
  );

  const config = qwenConfig(input.config);
  const hostAccess = !input.factory && qwenHostEnabled(input.providerSettings);
  const snapshot = await resolveQwenSnapshot(config, { signal: input.signal });
  const model = snapshot.models.find((entry) => entry.id === input.model);

  if (!model) {
    throw new Error('Qwen: модель недоступна в конфигурации modelProviders');
  }

  const workspace = await resolveQwenWorkspace(
    input.cwd || config.rootDir || process.cwd(), input.extraDirs,
  );
  const attachmentRoot = attachmentsDir ? await fs.realpath(attachmentsDir).catch((error) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }) : undefined;
  // Каталог доставки картинок добавляется общим чатом только в ход с вложением.
  // ACP получает байты, поэтому этот каталог не меняет workspace и не монтируется.
  const { cwd } = workspace;
  const extraDirs = workspace.extraDirs.filter((directory) => directory !== attachmentRoot);
  const roots = [cwd, ...extraDirs];
  const runtimeRoot = config.qwenRuntimeHome || path.join(config.dataHome || cwd, 'qwen-runtime');
  const home = await resolveQwenSessionHome({
    runtimeRoot: hostAccess ? path.join(runtimeRoot, 'host-builtin-v1') : runtimeRoot,
    chatKey: input.chatKey,
    cwd,
    fingerprint: snapshot.fingerprint,
    extraDirs,
    attachmentRoot,
    sessionId: input.sessionId,
  });
  const saved = path.join(home, 'session.json');

  const mode = input.permissionMode || 'default';

  if (!['default', 'auto', 'plan', 'yolo'].includes(mode)) {
    throw new Error('Qwen: неизвестный режим прав');
  }

  const mcpServers = (Array.isArray(input.mcpServers) ? input.mcpServers : []) as QwenMcpServer[];
  const readDirectories = [
    ...(Array.isArray(input.readonlyRoots) ? input.readonlyRoots.map(String) : []),
    ...(input.pluginDocsDirs || []),
  ];
  const readonlyRoots = [...new Set(await Promise.all(
    readDirectories.map((directory) => validateWorkdirPath(directory)),
  ))];
  const sink = createStepSink(input.onStep);
  const textSteps = createQwenTextSteps();
  const usage = createQwenUsage((tokens, info) => input.onProgress?.(tokens, info));
  const promptId = randomUUID();
  const settings = record(input.providerSettings);
  let sessionId = '';
  let active = false;
  let reply = '';
  let responseText = '';
  let lastResponse = '';
  let lastAssistantMessageId = '';
  let assistantRevision = 0;
  let awaitingAnswer = false;
  let actualModel = '';
  let currentMode = mode;
  let planExecutionMode: string | undefined;
  const tools = new Set<string>();
  const results = new Set<string>();
  const inTurn = createQwenInTurn({
    available: () => active && !awaitingAnswer && !input.signal?.aborted,
    sendNow: () => transport.client.request('craft/midTurnSendNow', { sessionId }),
    readImages: async (images) => {
      if (!transport.images) {
        throw new Error('Qwen: установленный CLI не поддерживает изображения. Обновите Qwen Code.');
      }

      return readQwenImages(images.map((image) => image.path), attachmentsDir, input.signal);
    },
  });

  /**
   * Текстовый блок получает один id и в ленте шагов, и в журнале ответов.
   * Полная реплика сохраняется отдельно от ограниченного предпросмотра шага.
   */
  function emitSteps(steps: ChatStep[]): void {
    for (const step of steps) {
      if (step.k === 'text') {
        lastResponse = responseText;
        responseText = '';
        lastAssistantMessageId = String(step.id);
        assistantRevision += 1;
        // Общий publisher хранит ошибку записи до финального flush чата.
        // Callback не должен оставлять необработанный rejection в reader ACP.
        void Promise.resolve(input.onAssistantMessage?.({
          assistantMessageId: lastAssistantMessageId,
          text: lastResponse,
          sourceRevision: assistantRevision,
          complete: true,
        })).catch(() => {});
      }

      sink.emit(step);
    }
  }

  /**
   * Модель называет CLI после выбора или обновления своей сессии.
   * Во время подготовки факт копится до успешного сохранения сессии перед prompt.
   */
  function reportModel(value: unknown): void {
    if (typeof value !== 'string' || !value.trim() || actualModel === value.trim()) {
      return;
    }

    actualModel = value.trim();

    if (active) {
      input.onRunMetadata?.({ actualModelId: actualModel, modelSource: 'session' });
    }
  }

  const transport = await openTransport(config, snapshot, {
    cwd,
    extraDirs,
    home,
    authType: model.authType,
    mode,
    mcpServers,
    readonlyRoots,
    hostAccess,
  }, {
    /**
     * Replay загрузки остаётся невидимым до начала нового prompt.
     * Идентификаторы tools связывают единственный результат с исходным вызовом.
     */
    onNotification(method, value) {
      const params = record(value);

      if (params.sessionId !== sessionId) {
        return;
      }

      if (method === 'qwen/notify/session/model-update') {
        reportModel(params.currentModelId);

        return;
      }

      if (method === 'qwen/notify/session/mode-update') {
        if (params.currentModeId === 'plan' && typeof params.planExecutionMode === 'string') {
          planExecutionMode = params.planExecutionMode;
        }

        if (active
          && ['default', 'auto', 'auto-edit', 'plan', 'yolo'].includes(String(params.currentModeId))) {
          currentMode = String(params.currentModeId);
        }

        return;
      }

      if (method !== 'session/update' || !active) {
        return;
      }

      const update = record(params.update);

      usage.observe(update);

      const kind = update.sessionUpdate;
      const text = String(record(update.content).text || '');
      const id = String(update.toolCallId || '');


      if (kind === 'current_mode_update') {
        if (['default', 'auto', 'auto-edit', 'plan', 'yolo'].includes(String(update.currentModeId))) {
          currentMode = String(update.currentModeId);
        }
      } else if (kind === 'config_option_update') {
        reportModel(qwenSelectedModel(update.configOptions));
      } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const k = kind === 'agent_message_chunk' ? 'text' : 'think';

        emitSteps(textSteps.append(k, text));

        if (k === 'text') {
          reply += text;
          responseText += text;
        }
      } else if (kind === 'tool_call' && id && !tools.has(id)) {
        emitSteps(textSteps.flush());
        tools.add(id);
        sink.emit({
          k: 'tool',
          id,
          name: update.title,
          input: update.rawInput,
        });
      } else if (kind === 'tool_call_update' && id
        && ['completed', 'failed'].includes(String(update.status)) && !results.has(id)) {
        emitSteps(textSteps.flush());
        results.add(id);
        sink.emit({
          k: 'res',
          id,
          text: JSON.stringify(update.content || []),
          ok: update.status === 'completed',
          error: update.status === 'failed',
        });
      }
    },
    /**
     * Защитный reverse RPC проверяется до любого эффекта инструмента.
     * Человеческое разрешение не преодолевает отмену или чужую identity.
     */
    async onReverseRequest(method, value) {
      const params = record(value);

      if (method === 'qwen/control/external_tool_guard/prepare') {
        emitSteps(textSteps.flush());

        // Host живёт между ходами: фоновые вызовы проверяет live actor, не локальный active.
        const allowed = (hostAccess || active) && await qwenToolAllowed(value, {
          sessionId,
          promptId,
          cwd,
          writableRoots: roots,
          mode: currentMode,
          readonlyRoots,
          mcpServers,
          blockDirectSsh: settings.blockDirectSsh !== false,
          hostAccess,
          signal: input.signal,
        });


        return { allowed: allowed && !input.signal?.aborted };
      }

      if (method === 'craft/drainMidTurnQueue') {
        if (params.sessionId !== sessionId || params.promptId !== promptId) {
          return { messages: [], hasQueuedPrompt: false };
        }

        emitSteps(textSteps.flush());

        return inTurn.drain();
      }

      if (method !== 'session/request_permission' || !active || params.sessionId !== sessionId) {
        throw new Error('Qwen: неизвестный reverse RPC');
      }

      emitSteps(textSteps.flush());

      const ask = input.onPermission as ((question: Record<string, unknown>) => Promise<unknown>) | undefined;

      awaitingAnswer = true;
      input.onInTurnAvailability?.({ available: false, reason: 'awaiting_answer' });

      try {
        return await qwenPermissionResponse(value, {
          ask,
          signal: input.signal,
          factory: Boolean(input.factory),
          planExecutionMode,
        });
      } finally {
        awaitingAnswer = false;

        if (active && !input.signal?.aborted) {
          input.onInTurnAvailability?.({ available: true });
        }
      }
    },
  });
  let abort: (() => void) | undefined;
  let promptSettled: Promise<void> | undefined;

  try {
    if (imageContent.length && !transport.images) {
      throw new Error('Qwen: установленный CLI не поддерживает изображения. Обновите Qwen Code.');
    }

    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        try {
          transport.client.notify('session/cancel', { sessionId });
        } catch {
          // Отмена могла прийти после EOF.
        }

        reject(new Error('Qwen: ход отменён'));
      };
      input.signal?.addEventListener('abort', abort, { once: true });

      if (input.signal?.aborted) {
        abort();
      }
    });
    /**
     * Отмена прекращает ожидание RPC, сохраняя короткие сроки настройки и длинный prompt.
     * Исходный promise prompt остаётся доступен для ограниченного завершения native-записи.
     */
    const request = (method: string, params: unknown, timeoutMs?: number) => {
      if (input.signal?.aborted) {
        return aborted;
      }

      const pending = transport.client.request(method, params, timeoutMs);

      if (method === 'session/prompt') {
        promptSettled = pending.then(() => undefined, () => undefined);
      }

      return Promise.race([pending, aborted]);
    };
    const session = record(await request(input.sessionId ? 'session/load' : 'session/new', {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cwd,
      mcpServers,
    }));

    sessionId = input.sessionId || String(session.sessionId || '');

    if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error('Qwen: неверная identity новой сессии');
    }

    const available = record(session.models).availableModels;

    if (!Array.isArray(available) || !available.some((entry) => record(entry).modelId === model.id)) {
      throw new Error('Qwen: native CLI не подтвердил выбранную модель');
    }

    const modes = record(session.modes).availableModes;

    if (!Array.isArray(modes) || !modes.some((entry) => record(entry).id === mode)) {
      throw new Error('Qwen: выбранный режим прав недоступен в установленном CLI. Обновите Qwen Code.');
    }

    let modelOptions: unknown;

    if (Array.isArray(session.configOptions)) {
      const selected = record(await request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: model.id,
      }));

      modelOptions = selected.configOptions;
      reportModel(qwenSelectedModel(modelOptions));
    } else {
      if (hostAccess) {
        throw new Error('Qwen: Host требует native model configOptions');
      }

      await request('session/set_model', { sessionId, modelId: model.id });
    }

    const reasoning = qwenEffortOption(modelOptions);
    const effort = input.effort || '';

    if (effort && !reasoning?.levels.includes(effort)) {
      throw new Error('Qwen: выбранное усилие недоступно у этой модели. Обновите каталог моделей.');
    }

    if (reasoning) {
      const applied = record(await request('session/set_config_option', {
        sessionId,
        configId: 'reasoning_effort',
        value: effort || 'default',
      }));
      const confirmed = qwenEffortOption(applied.configOptions);

      if (!confirmed || (effort && effort !== 'default' && confirmed.current !== effort)) {
        throw new Error('Qwen: CLI не подтвердил выбранное усилие. Запрос к модели не отправлен.');
      }
    }

    await request('session/set_mode', { sessionId, modeId: mode });
    await fs.writeFile(saved, sessionId, { mode: 0o600 });
    await input.onSessionCreated?.(sessionId);
    input.signal?.throwIfAborted();
    active = true;

    if (actualModel) {
      input.onRunMetadata?.({ actualModelId: actualModel, modelSource: 'session' });
    }

    sink.emit({
      k: 'start',
      model: model.id,
      cwd,
      mode,
    });

    // Prompt отвечает после всего хода, включая инструменты и ожидание человека.
    // Ему нужен суточный предел общего ACP-клиента; настройки сохраняют свои 30 секунд.
    const prompt = request('session/prompt', {
      sessionId,
      prompt: qwenPromptContent(input.message || '', imageContent),
      _meta: {
        'qwen-code/invocation': {
          version: 1,
          sessionId,
          promptId,
        },
      },
    }, 24 * 60 * 60 * 1000);

    input.onInTurnReady?.(inTurn.port);
    input.onInTurnAvailability?.({ available: true });

    const result = record(await prompt);

    active = false;
    inTurn.close();

    input.signal?.throwIfAborted();

    if (result.stopReason === 'cancelled') {
      throw Object.assign(new Error('Qwen: ход отменён'), { stopped: true });
    }

    if (result.stopReason !== 'end_turn') {
      throw new Error(`Qwen: ход завершён без ответа (${String(result.stopReason)})`);
    }

    emitSteps(textSteps.flush());

    return {
      reply: input.onAssistantMessage ? lastResponse || reply : reply,
      sessionId,
      steps: sink.steps,
      ...usage.result(),
      ...(input.onAssistantMessage && lastAssistantMessageId
        ? { assistantMessageId: lastAssistantMessageId } : {}),
      ...(actualModel ? { actualModel } : {}),
    };
  } catch (error) {
    const details = error instanceof AcpRpcError ? record(error.data).details : undefined;
    const reason = error instanceof AcpRpcError && typeof details === 'string'
      ? `${error.message}: ${details}` : error;

    const failure = new Error(redactRunnerError(reason, snapshot.envKeys.map((key) => process.env[key])));

    if (input.signal?.aborted || record(error).stopped === true) {
      Object.assign(failure, {
        stopped: true,
        sessionId: sessionId || input.sessionId || null,
        steps: sink.steps,
      });
    }

    throw failure;
  } finally {
    active = false;
    inTurn.close();
    input.onInTurnAvailability?.({ available: false, reason: 'not_ready' });
    emitSteps(textSteps.flush());

    if (abort) {
      input.signal?.removeEventListener('abort', abort);
    }

    // ACK отменённого prompt позволяет CLI дописать native-память первого хода.
    // Инструменты уже закрыты через active/signal; зависший CLI получает не больше секунды.
    if (input.signal?.aborted && promptSettled) {
      const grace = new AbortController();
      const expired = delay(1000, undefined, { signal: grace.signal }).catch(() => undefined);

      await Promise.race([promptSettled, expired]);
      grace.abort();
    }

    await transport.close();
  }
}
