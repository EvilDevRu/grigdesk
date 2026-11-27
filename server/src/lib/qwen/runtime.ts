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
import { createQwenSteps, qwenStepParent } from './steps.ts';
import { createQwenUsage } from './usage.ts';
import { resolveQwenWorkspace } from './workspace.ts';
import { resolveQwenSessionHome } from './session.ts';
import { resolveQwenSkills } from './skills.ts';
import { qwenPreviewToolAllowed } from './previewPolicy.ts';
import { qwenPreviewModelId } from './previewModels.ts';
import { qwenPermissionResponse } from './permissions.ts';
import { qwenPromptContent, readQwenImages } from './images.ts';
import type { QwenMcpServer } from './sandbox.ts';

const WORK_MCP_UNAVAILABLE = 'Qwen не смог подключить рабочие инструменты GrigDesk.';

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

  const nativeModelId = qwenPreviewModelId(model);

  if (!nativeModelId) {
    throw new Error('Qwen Preview.2: протокол выбранной модели не поддерживается.');
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
    runtimeRoot: path.join(runtimeRoot, hostAccess ? 'preview2-host' : 'preview2-acp'),
    chatKey: input.chatKey,
    cwd,
    fingerprint: snapshot.fingerprint,
    extraDirs,
    sessionId: input.sessionId,
  });
  const saved = path.join(home, 'session.json');

  const mode = input.permissionMode || 'default';

  if (!['default', 'auto', 'plan', 'yolo'].includes(mode)) {
    throw new Error('Qwen: неизвестный режим прав');
  }

  const mcpServers = (Array.isArray(input.mcpServers) ? input.mcpServers : []) as QwenMcpServer[];
  const skills = input.factory || hostAccess ? { directories: [], roots: [] } : await resolveQwenSkills();
  const readDirectories = [
    ...(Array.isArray(input.readonlyRoots) ? input.readonlyRoots.map(String) : []),
    ...(input.pluginDocsDirs || []),
    ...skills.roots,
  ];
  const readonlyRoots = [...new Set(await Promise.all(
    readDirectories.map((directory) => validateWorkdirPath(directory)),
  ))];
  const sink = createStepSink(input.onStep);
  const streamSteps = createQwenSteps();
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
  let actualModel = '';
  let approvalCount = 0;

  /**
   * Передача уточнений ждёт ответы человека. Счётчик учитывает несколько
   * одновременно запрошенных разрешений от параллельных инструментов.
   */
  function publishInTurnAvailability(): void {
    input.onInTurnAvailability?.(approvalCount > 0
      ? { available: false, reason: 'awaiting_answer' }
      : { available: active && !input.signal?.aborted });
  }

  /**
   * Граница ответа соответствует завершённому ACP prompt. Преждевременно закрытый
   * или отменённый запрос не становится успешно доставленным уточнением.
   */
  function finishPrompt(value: unknown): void {
    input.signal?.throwIfAborted();

    if (transport.workMcpUnavailable?.()) {
      throw new Error(WORK_MCP_UNAVAILABLE);
    }

    const result = record(value);

    if (result.stopReason === 'cancelled') {
      throw Object.assign(new Error('Qwen: ход отменён'), { stopped: true });
    }

    if (result.stopReason !== 'end_turn') {
      throw new Error(`Qwen: ход завершён без ответа (${String(result.stopReason)})`);
    }

    usage.observePromptResult(result);
    emitSteps(streamSteps.flush());
  }

  /**
   * Текстовый блок получает один id и в ленте шагов, и в журнале ответов.
   * Полная реплика сохраняется отдельно от ограниченного предпросмотра шага.
   */
  function emitSteps(steps: ChatStep[]): void {
    for (const step of steps) {
      if (step.k === 'text' && !step.parent) {
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
    const confirmed = snapshot.models.find((entry) => qwenPreviewModelId(entry) === value);

    if (!confirmed || actualModel === confirmed.id) {
      return;
    }

    actualModel = confirmed.id;

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
    nativeModelId,
    mcpServers,
    readonlyRoots,
    skillDirectories: skills.directories,
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

      if (method !== 'session/update' || !active || transport.workMcpUnavailable?.()) {
        return;
      }

      const update = record(params.update);

      usage.observe(update);

      const kind = update.sessionUpdate;
      const text = String(record(update.content).text || '');

      if (kind === 'config_option_update') {
        reportModel(qwenSelectedModel(update.configOptions));
      } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const k = kind === 'agent_message_chunk' ? 'text' : 'think';

        emitSteps(streamSteps.observe(update));

        if (k === 'text' && !qwenStepParent(update)) {
          reply += text;
          responseText += text;
        }
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        emitSteps(streamSteps.observe(update));
      }
    },
    /**
     * Защитный reverse RPC проверяется до любого эффекта инструмента.
     * Человеческое разрешение не преодолевает отмену или чужую identity.
     */
    async onReverseRequest(method, value) {
      if (method !== 'session/request_permission') {
        throw new Error('Qwen: неизвестный reverse RPC');
      }

      const allowed = active && await qwenPreviewToolAllowed(value, {
        sessionId,
        promptId,
        cwd,
        writableRoots: hostAccess ? [path.parse(cwd).root] : roots,
        mode,
        readonlyRoots,
        skillDirectory: skills.directories[0],
        mcpServers,
        blockDirectSsh: settings.blockDirectSsh !== false,
        signal: input.signal,
      });

      if (!allowed || !active || input.signal?.aborted) {
        return { outcome: { outcome: 'cancelled' } };
      }

      // Preview.2 объявляет инструмент внутри запроса разрешения. Далее CLI
      // может прислать только обновление статуса без имени и аргументов.
      const tool = record(record(value).toolCall);
      const name = record(record(tool._meta).qwen).toolName;

      emitSteps(streamSteps.observe({
        ...tool,
        title: typeof name === 'string' ? name : tool.title,
        sessionUpdate: 'tool_call',
      }));

      const preapproved = mode === 'yolo' || mode === 'plan';
      const ask = preapproved ? undefined
        : input.onPermission as ((question: Record<string, unknown>) => Promise<unknown>) | undefined;

      if (ask) {
        approvalCount += 1;
        publishInTurnAvailability();
      }

      try {
        return await qwenPermissionResponse(value, {
          ask,
          signal: input.signal,
          preapproved,
          factory: Boolean(input.factory),
          requiresExplicitUser: mode !== 'auto',
        });
      } finally {
        if (ask) {
          approvalCount -= 1;
          publishInTurnAvailability();
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
        const settled = pending.then(() => undefined, () => undefined);

        promptSettled = promptSettled ? Promise.all([promptSettled, settled]).then(() => {}) : settled;
      }

      return Promise.race([pending, aborted]);
    };
    const session = record(await request(input.sessionId ? 'session/load' : 'session/new', {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cwd,
      mcpServers,
      additionalDirectories: extraDirs,
    }));

    sessionId = input.sessionId || String(session.sessionId || '');

    if (!sessionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
      throw new Error('Qwen: неверная identity новой сессии');
    }

    const modelOptions = session.configOptions;

    if (qwenSelectedModel(modelOptions) !== nativeModelId) {
      throw new Error('Qwen: CLI не подтвердил выбранную модель.');
    }

    reportModel(nativeModelId);

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
    const primary = request('session/prompt', {
      sessionId,
      prompt: qwenPromptContent(input.message || '', imageContent),
      messageId: promptId,
    }, 24 * 60 * 60 * 1000);
    const followUps: Promise<void>[] = [];
    let acceptFollowUps = true;

    input.onInTurnReady?.({
      /**
       * Стандартный ACP ставит запрос в очередь этой же сессии. Передача в stdin
       * подтверждается отдельно от ответа CLI о завершении запроса.
       */
      async deliver({ messageId, text, images = [] }) {
        const usable = () => acceptFollowUps && active && approvalCount === 0
          && !input.signal?.aborted && !transport.client.closed;

        if (!usable() || (images.length && !transport.images)) {
          return {
            ok: false,
            code: 'in_turn_unavailable',
            message: 'Канал уточнений Qwen недоступен.',
          };
        }

        let content: Awaited<ReturnType<typeof readQwenImages>>;

        try {
          content = await readQwenImages(images.map((image) => image.path), attachmentsDir, input.signal);
        } catch (error) {
          return {
            ok: false,
            code: 'attachment_unavailable',
            message: error instanceof Error ? error.message : 'Qwen: изображение недоступно.',
          };
        }

        if (!usable()) {
          return {
            ok: false,
            code: 'turn_changed',
            message: 'Активный ход Qwen завершился.',
          };
        }

        const followUp = request('session/prompt', {
          sessionId,
          prompt: qwenPromptContent(text, content),
          messageId: randomUUID(),
        }, 24 * 60 * 60 * 1000);

        followUps.push(followUp.then((result) => {
          finishPrompt(result);

          return input.onInTurnReceipt?.({ messageId, state: 'consumed' });
        }).catch(() => input.onInTurnReceipt?.({
          messageId,
          state: 'unknown',
          error: 'Qwen не подтвердил завершение уточнения.',
        })).then(() => {}));

        return { ok: true, state: 'forwarded' };
      },
      close() {
        acceptFollowUps = false;
      },
    });
    publishInTurnAvailability();
    finishPrompt(await primary);

    for (const followUp of followUps) {
      await followUp;
    }

    active = false;
    input.signal?.throwIfAborted();

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
    if (transport.workMcpUnavailable?.() && !input.signal?.aborted) {
      throw new Error(WORK_MCP_UNAVAILABLE);
    }

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
    input.onInTurnAvailability?.({ available: false, reason: 'not_ready' });
    emitSteps(streamSteps.flush());

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
