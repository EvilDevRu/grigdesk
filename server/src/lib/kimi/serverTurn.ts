// Ход Kimi через серверный транспорт: сессия, prompt, поток событий и ввод в активный ход.
//
// Драйвер связывает три части: runtime (`kimi web`), REST-клиент и поток событий. Он же
// отдаёт наружу порт уточнений: сообщение уходит prompt'ом и уводится в идущий ход через
// `prompts:steer`, а видимый ответ приходит событиями `assistant.delta`/`assistant.completed`.
import { normalizeContextUsage } from '../../../../shared/chat/chatContextUsage.ts';
import type { ChatContextUsage } from '../../../../shared/chat/chatContextUsage.ts';

import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import type {
  InTurnAssistantEvent,
  InTurnPort,
  InTurnUnavailableReason,
} from '../../../../shared/chat/chatInTurnContracts.ts';
import { openKimiEventStream } from './serverEvents.ts';
import type { KimiRawEvent } from './serverEvents.ts';
import type { KimiServerProcess } from './serverRuntime.ts';
import { startKimiServer } from './serverRuntime.ts';
import type { KimiServerClient } from './serverClient.ts';
import type { StartKimiServerOptions } from './serverRuntime.ts';
import type { PreparedNativeSettings } from '../executorSettings/types.ts';
import { applyKimiNativeSettings } from '../executorSettings/kimi.ts';

export interface KimiServerTurnOptions {
  bin: string;
  home: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  message: string;
  sessionId?: string | null;
  permissionMode?: string;
  planMode?: boolean;
  effort?: string;
  signal?: AbortSignal;
  nativeSettings?: PreparedNativeSettings;
  controlledCommands?: boolean;
  onCommandContext?: (client: KimiServerClient, sessionId: string) => void | Promise<void>;
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  startServer?: (input: StartKimiServerOptions) => Promise<KimiServerProcess>;
  // Спросы человека: разрешение инструмента и вопрос агента приходят событиями потока.
  // Второй аргумент — ответ: адаптер показывает спрос человеку и отправляет вердикт.
  onApproval?: (
    approval: Record<string, unknown>,
    respond: (input: {
      decision: string;
      scope?: string;
      feedback?: string;
      selectedLabel?: string;
    }) => Promise<unknown>,
  ) => void | Promise<void>;
  onQuestion?: (
    question: Record<string, unknown>,
    respond: (input: {
      answers: Record<string, unknown>;
      method?: string;
      note?: string;
    }) => Promise<unknown>,
  ) => void | Promise<void>;
  log?: {
    info?: (fields: Record<string, unknown>, message: string) => void;
    warn?: (fields: Record<string, unknown>, message: string) => void;
  } | null;
}

export interface KimiServerTurnResult extends ChatContextUsage {
  reply: string;
  assistantMessageId?: string;
  sessionId: string;
  steps: ChatStep[];
}

/** Текст сообщения из payload события `assistant.completed`. */
function completedText(payload: Record<string, unknown> | undefined): string {
  const content = Array.isArray(payload?.content) ? payload.content : [];

  return content
    .map((part) => {
      const block = part as { type?: unknown; text?: unknown };

      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Один ход: сессия, prompt и ожидание `turn.ended`. Порт уточнений открывается сразу после
 * подписки, поэтому человек может спросить, пока агент ещё работает.
 */
export async function runKimiServerTurn(options: KimiServerTurnOptions): Promise<KimiServerTurnResult> {
  const server: KimiServerProcess = await (options.startServer || startKimiServer)({
    bin: options.bin,
    home: options.home,
    debugEndpoints: options.controlledCommands === true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    log: options.log || null,
  });

  try {
    if (options.nativeSettings?.accepted.length) {
      await applyKimiNativeSettings(server.client, options.nativeSettings, options.signal);
    }

    const session = options.sessionId
      ? { id: options.sessionId }
      : await server.client.createSession({
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
      });

    if (!session.id) {
      throw new Error('Kimi server не назвал id сессии.');
    }

    if (!options.sessionId) {
      await options.onSessionCreated?.(session.id);
    }

    if (options.controlledCommands) {
      if (options.sessionId) {
        await server.client.snapshot(session.id);
      }

      const response = await server.client.tools(session.id);
      const tools = Array.isArray(response.tools) ? response.tools : [];
      const bash = tools.find((raw) => raw && typeof raw === 'object'
        && (raw as Record<string, unknown>).name === 'Bash') as Record<string, unknown> | undefined;

      if (bash?.active !== false) {
        throw new Error('kimi_native_bash_not_disabled');
      }
    }

    if (options.controlledCommands) {
      await options.onCommandContext?.(server.client, session.id);
    }

    const stepSink = createStepSink(options.onStep);
    const drafts = new Map<string, string>();
    const completed = new Map<string, string>();
    let reply = '';
    let replyMessageId = '';
    let lastContextUsage: ChatContextUsage = {};
    let awaitingAnswer = false;
    let finished = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    let currentTextId = '';
    let stepNumber = 0;
    let turnNumber = '';
    const writes = new Set<Promise<void>>();
    const outputByStep = new Map<string, number>();

    const outputTokens = () => [...outputByStep.values()].reduce((sum, value) => sum + value, 0);

    const saveMessage = (event: InTurnAssistantEvent) => {
      const write = Promise.resolve(options.onAssistantMessage?.(event));

      writes.add(write);
      write.finally(() => writes.delete(write)).catch(() => {});
    };

    const notify = () => {
      wake?.();
      wake = null;
    };
    const emit = (step: ChatStep) => {
      stepSink.emit(step);
    };

    /**
     * Реальный поток Kimi завершает текст на границе шага, а тестовый сервер может
     * прислать assistant.completed. Оба пути сохраняют один и тот же id блока.
     */
    const finishText = (id: string, explicitText = '') => {
      const text = explicitText || drafts.get(id) || '';

      if (!id || !text || completed.has(id)) {
        return;
      }

      completed.set(id, text);
      reply = text;
      replyMessageId = id;
      emit({
        k: 'text',
        id,
        text,
      });
      saveMessage({
        assistantMessageId: id,
        text,
        sourceRevision: text.length,
        complete: true,
      });
    };

    const stream = openKimiEventStream({
      baseUrl: server.baseUrl,
      token: server.token,
      sessionIds: [session.id],
      onEvent: (event: KimiRawEvent) => {
        try {
          handleEvent(event);
        } catch (error) {
          options.log?.warn?.({ err: (error as Error)?.message }, 'чат: сбой разбора события Kimi');
        }
      },
      onClose: () => {
        if (!finished) {
          failure = new Error('Поток событий Kimi закрылся до завершения хода.');
          finished = true;
          notify();
        }
      },
      onError: (error) => {
        if (!finished) {
          failure = error;
          finished = true;
          notify();
        }
      },
    });

    /**
     * Разбор кадра сервера в ленту и видимые блоки. Идентификатор блока — id сообщения
     * сервера, поэтому шаг и блок склеиваются по нему, а не по тексту.
     */
    function handleEvent(event: KimiRawEvent): void {
      const payload = event.payload || {};
      // Сервер шлёт дельты текста БЕЗ префикса `event.` (это поток агента), а события
      // сессии — с префиксом. Принимаем обе формы: протокол принадлежит серверу, и
      // потерять из-за префикса видимый текст нельзя.
      const kind = event.type.startsWith('event.') ? event.type.slice(6) : event.type;
      const agentId = String(payload.agentId || event.agentId || payload.agent_id || 'main');

      if (agentId !== 'main' && (
        kind === 'assistant.delta' || kind === 'assistant.completed' || kind === 'thinking.delta'
        || kind === 'turn.started' || kind === 'turn.step.started' || kind === 'turn.step.completed'
        || kind === 'turn.ended' || kind === 'agent.status.updated' || kind === 'turn.step.interrupted'
      )) {
        return;
      }

      if (kind === 'turn.started') {
        turnNumber = String(payload.turnId || payload.turn_id || '');

        return;
      }

      if (kind === 'turn.step.started') {
        finishText(currentTextId);
        stepNumber += 1;
        currentTextId = `kimi-${turnNumber || 'turn'}-${stepNumber}`;

        return;
      }

      if (kind === 'turn.step.completed') {
        finishText(currentTextId);

        const usage = (payload.usage || {}) as Record<string, unknown>;
        const output = usage.output;

        if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) {
          // Повтор шага заменяет свой вклад; внутренний turn.started не начинает новый ход человека.
          // При старом протоколе без stepId пару turnId/step сохраняем раздельно.
          const key = payload.stepId != null ? `${agentId}:${payload.stepId}`
            : `${agentId}:${payload.turnId ?? turnNumber}:${payload.step ?? stepNumber}`;

          outputByStep.set(key, output);
          options.onProgress?.(outputTokens(), { tokensIsEstimate: false });
        }

        return;
      }

      if (kind === 'thinking.delta') {
        const delta = String(payload.delta ?? '');

        if (delta) {
          emit({ k: 'think', text: delta });
        }

        return;
      }

      if (kind === 'agent.status.updated') {
        const patch = normalizeContextUsage({
          contextTokens: payload.contextTokens,
          contextWindow: payload.maxContextTokens,
        });

        if (patch.contextTokens === undefined && patch.contextWindow === undefined) {
          return;
        }

        // Статусы приходят частями; модель, usage и режимы не обнуляют замер.
        // Меньший contextTokens заменяет прежний после сжатия основного агента.
        lastContextUsage = { ...lastContextUsage, ...patch };

        if (lastContextUsage.contextTokens !== undefined) {
          lastContextUsage.contextMetric = 'kimi-agent-status-v1';
          options.onProgress?.(outputTokens(), { tokensIsEstimate: false, ...lastContextUsage });
        }

        return;
      }

      if (kind === 'session.usage_updated') {
        const usage = (payload.usage || {}) as Record<string, unknown>;
        const context = normalizeContextUsage({
          contextTokens: usage.context_tokens,
          contextWindow: usage.context_limit,
          contextMetric: 'kimi-active-input-v1',
          contextIsEstimate: false,
        });

        if (context.contextTokens !== undefined) {
          lastContextUsage = { ...lastContextUsage, ...context };
          options.onProgress?.(outputTokens(), { tokensIsEstimate: false, ...lastContextUsage });
        }

        return;
      }

      if (kind === 'assistant.delta') {
        const id = String(payload.message_id || payload.messageId || currentTextId
          || `kimi-${turnNumber || 'turn'}-${++stepNumber}`);
        const delta = String(payload.delta ?? '');

        if (!id || !delta) {
          return;
        }

        const text = `${drafts.get(id) || ''}${delta}`;

        currentTextId = id;
        drafts.set(id, text);
        emit({
          k: 'text',
          id,
          text,
        });
        saveMessage({
          assistantMessageId: id,
          text,
          sourceRevision: text.length,
          complete: false,
        });

        return;
      }

      if (kind === 'assistant.completed') {
        const id = String(payload.message_id || payload.messageId || currentTextId);
        const text = completedText(payload) || drafts.get(id) || '';

        if (!id || !text) {
          return;
        }

        finishText(id, text);

        return;
      }

      if (kind === 'tool.call.started') {
        const id = String(payload.toolCallId || payload.tool_call_id || '');
        const name = String(payload.name || payload.tool_name || 'Инструмент');
        const display = (payload.display || {}) as Record<string, unknown>;
        const args = (payload.args || {}) as Record<string, unknown>;
        const file = String(display.path || args.path || args.file_path || '');
        const operation = String(display.operation || '');
        const changed = display.kind === 'diff' || operation === 'write' || operation === 'edit';
        const before = String(display.before || '');
        const after = String(display.after || display.content || '');

        emit({
          k: 'tool',
          id,
          tool: name,
          kind: display.kind === 'command' ? 'execute'
            : changed ? 'edit' : display.kind === 'search' ? 'search' : 'read',
          text: String(display.description || display.command || file || name),
          ...(changed && file ? {
            files: [file],
            changes: [{
              path: file,
              kind: before ? 'update' : 'add',
              diff: { old: before, new: after },
            }],
          } : {}),
        });

        return;
      }

      if (kind === 'tool.result') {
        emit({
          k: 'res',
          id: String(payload.toolCallId || payload.tool_call_id || ''),
          ok: payload.isError !== true && payload.is_error !== true,
          text: String(payload.output || ''),
        });

        return;
      }

      if (kind === 'approval.requested' || kind === 'question.requested') {
        // Пока человек не ответил, уточнение не должно выглядеть как ответ на спрос.
        awaitingAnswer = true;
        options.onInTurnAvailability?.({ available: false, reason: 'awaiting_answer' });

        const approvalId = String(payload.approval_id || '');
        const questionId = String(payload.question_id || payload.id || '');
        const respondApproval = (input: {
          decision: string;
          scope?: string;
          feedback?: string;
          selectedLabel?: string;
        }) => server.client.respondApproval(session.id, approvalId, input);
        const respondQuestion = (input: {
          answers: Record<string, unknown>;
          method?: string;
          note?: string;
        }) => server.client.respondQuestion(session.id, questionId, input);

        if (kind === 'approval.requested') {
          void Promise.resolve(options.onApproval?.(payload, respondApproval)).catch((error) => {
            failure = error as Error;
            finished = true;
            notify();
          });
        } else {
          void Promise.resolve(options.onQuestion?.(payload, respondQuestion)).catch((error) => {
            failure = error as Error;
            finished = true;
            notify();
          });
        }

        return;
      }

      if (kind === 'approval.resolved' || kind === 'question.answered' || kind === 'question.dismissed') {
        awaitingAnswer = false;
        options.onInTurnAvailability?.({ available: true });

        return;
      }

      if (kind === 'turn.ended') {
        finishText(currentTextId);
        options.onInTurnAvailability?.({ available: false, reason: 'not_ready' });

        if (payload.reason === 'cancelled') {
          failure = Object.assign(new Error('Ход остановлен.'), { stopped: true });
        } else if (payload.reason === 'failed' || payload.reason === 'blocked') {
          failure = new Error(`Ход Kimi завершился: ${payload.reason}`);
        }

        finished = true;
        notify();

        return;
      }

      if (kind === 'prompt.aborted' || kind === 'turn.step.interrupted') {
        finished = true;
        failure = Object.assign(new Error('Ход остановлен.'), { stopped: true });
        notify();
      }
    }

    await stream.ready;

    const port: InTurnPort = {
      /**
       * Передача уточнения в активный ход. Пока агент ждёт ответа на спрос, канал закрыт:
       * иначе «да» из композера выглядело бы ответом на вопрос о работе.
       */
      async deliver({ messageId, text }) {
        if (finished || options.signal?.aborted) {
          return {
            ok: false,
            code: 'kimi_turn_closed',
            message: 'Активный ход Kimi уже завершился.',
          };
        }

        if (awaitingAnswer) {
          return {
            ok: false,
            code: 'awaiting_answer',
            message: 'Агент ждёт ответа на вопрос: уточнение не должно его подменить.',
          };
        }

        return server.client.deliverInTurn(session.id, {
          text,
          userMessageId: messageId,
          ...(options.model ? { model: options.model } : {}),
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
          ...(options.planMode !== undefined ? { planMode: options.planMode } : {}),
        });
      },
      close() {},
    };

    /**
     * Стоп человека прерывает только этот prompt и будит ожидающий драйвер.
     * Остановка серверного процесса выполняется в общем finally.
     */
    const onAbort = () => {
      finished = true;
      failure = Object.assign(new Error('Ход остановлен.'), { stopped: true });
      notify();
      void server.client.abortSession(session.id).catch(() => {});
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.signal?.aborted) {
      onAbort();
    }

    try {
      if (finished) {
        throw failure || new Error('Ход Kimi остановлен до запуска.');
      }

      await server.client.submitPrompt(session.id, {
        text: options.message,
        ...(options.model ? { model: options.model } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.planMode !== undefined ? { planMode: options.planMode } : {}),
        ...(options.effort ? { thinking: options.effort } : {}),
      });

      if (!finished && !options.signal?.aborted) {
        options.onInTurnReady?.(port);
        options.onInTurnAvailability?.(awaitingAnswer
          ? { available: false, reason: 'awaiting_answer' }
          : { available: true });
      }

      while (!finished) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 250);
        });
      }

      if (failure) {
        throw failure;
      }

      await Promise.all([...writes]);

      return {
        ...lastContextUsage,
        reply,
        assistantMessageId: replyMessageId,
        sessionId: session.id,
        steps: stepSink.steps,
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      stream.close();
    }
  } finally {
    await server.stop();
  }
}
