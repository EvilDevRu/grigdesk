// Ход Kimi через серверный транспорт: сессия, prompt, поток событий и ввод в активный ход.
//
// Драйвер связывает три части: runtime (`kimi web`), REST-клиент и поток событий. Он же
// отдаёт наружу порт уточнений: сообщение уходит prompt'ом и уводится в идущий ход через
// `prompts:steer`, а видимый ответ приходит событиями `assistant.delta`/`assistant.completed`.
import { normalizeContextUsage } from '../../../../shared/chat/chatContextUsage.ts';
import type { ChatContextUsage } from '../../../../shared/chat/chatContextUsage.ts';
import type { ChatRunMetadata } from '../../../../shared/chat/chatRun.ts';
import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import { textOr, trimmedText } from '../../../../shared/lib/text.ts';

import { createStepSink, cut, cutMiddle, STEP_THINK_LIMIT } from '../chat/streamSteps.ts';
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
import { kimiTurnError } from './turnFailure.ts';
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
  verifyTools?: (client: KimiServerClient, sessionId: string) => Promise<void>;
  onCommandContext?: (client: KimiServerClient, sessionId: string) => void | Promise<void>;
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
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
  actualModel?: string;
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
    debugEndpoints: options.controlledCommands === true || Boolean(options.verifyTools),
    signal: options.signal,
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

    await options.verifyTools?.(server.client, session.id);

    const stepSink = createStepSink(options.onStep);
    const drafts = new Map<string, string>();
    const completed = new Map<string, string>();
    let reply = '';
    let replyMessageId = '';
    let actualModel = '';
    let lastContextUsage: ChatContextUsage = {};
    let awaitingAnswer = false;
    let finished = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    let currentTextId = '';
    let stepNumber = 0;
    let turnNumber = '';
    let thought = '';
    let thoughtAt = 0;
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
     * Выпускает непрерывное размышление перед следующим действием или выходом.
     * Время первой дельты сохраняет его место перед уже принятым уточнением.
     */
    const flushThought = () => {
      const text = thought.trim();
      const at = thoughtAt;

      thought = '';
      thoughtAt = 0;

      if (text) {
        emit({
          k: 'think',
          text: cut(text, STEP_THINK_LIMIT),
          at,
        });
      }
    };

    /**
     * Реплика закрывается до исполнения инструмента, не ожидая конца долгого шага.
     * Граница шага и assistant.completed сохраняют тот же id и не дублируют блок.
     */
    const finishText = (id: string, explicitText = '') => {
      const text = explicitText || drafts.get(id) || '';

      if (!id || !text.trim() || completed.has(id)) {
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
      onClose: ({ code, reason }) => {
        if (!finished) {
          // Код 1005 обозначает отсутствие статуса в close-кадре, а не причину сервера.
          // Если подробностей нет, сохраняем прежний текст ошибки.
          const codeText = code && code !== 1005 ? `код ${code}` : '';
          const details = [codeText, reason].filter(Boolean).join(': ');

          failure = new Error(`Поток событий Kimi закрылся до завершения хода${
            details ? ` (${details})` : ''
          }.`);
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
      if (finished) {
        return;
      }

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
        || kind === 'prompt.aborted' || kind === 'error'
      )) {
        return;
      }

      if (kind === 'turn.started') {
        flushThought();
        turnNumber = String(payload.turnId || payload.turn_id || '');

        return;
      }

      if (kind === 'turn.step.started') {
        flushThought();
        finishText(currentTextId);
        stepNumber += 1;
        currentTextId = `kimi-${turnNumber || 'turn'}-${stepNumber}`;

        return;
      }

      if (kind === 'turn.step.completed') {
        flushThought();
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
          if (!thought) {
            thoughtAt = Date.now();
          }

          thought = `${thought}${delta}`.slice(0, STEP_THINK_LIMIT * 2);
        }

        return;
      }

      if (kind === 'agent.status.updated') {
        const model = trimmedText(payload.model);

        if (model) {
          actualModel = model;
          options.onRunMetadata?.({ actualModelId: model, modelSource: 'session' });
        }

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

        flushThought();

        const text = `${drafts.get(id) || ''}${delta}`;

        currentTextId = id;
        drafts.set(id, text);

        if (!text.trim() || completed.has(id)) {
          return;
        }

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

        flushThought();
        finishText(id, text);

        return;
      }

      if (kind === 'tool.call.started') {
        flushThought();
        finishText(currentTextId);

        const id = String(payload.toolCallId || payload.tool_call_id || '');
        const name = trimmedText(payload.name) || trimmedText(payload.tool_name) || 'Инструмент';
        const display = recordOrEmpty(payload.display);
        const args = recordOrEmpty(payload.args);
        const file = textOr(display.path) || textOr(args.path) || textOr(args.file_path);
        const command = trimmedText(display.command) || trimmedText(args.command)
          || trimmedText(args.cmd) || trimmedText(args.script);
        const title = trimmedText(display.description) || command.split('\n')[0] || trimmedText(file)
          || trimmedText(args.pattern) || trimmedText(args.query) || trimmedText(args.regex) || name;
        const operation = String(display.operation || '');
        const changed = display.kind === 'diff' || operation === 'write' || operation === 'edit';
        const before = String(display.before || '');
        const after = String(display.after || display.content || '');

        emit({
          k: 'tool',
          id,
          name,
          title: cut(title, 200),
          ...(command ? { command: cutMiddle(command), lang: 'bash' } : {}),
          sub: file || textOr(args.glob),
          preview: Object.keys(args).length ? cut(JSON.stringify(args), 600) : '',
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
        flushThought();
        emit({
          k: 'res',
          id: String(payload.toolCallId || payload.tool_call_id || ''),
          ok: payload.isError !== true && payload.is_error !== true,
          text: String(payload.output || ''),
        });

        return;
      }

      if (kind === 'approval.requested' || kind === 'question.requested') {
        flushThought();
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
        flushThought();
        awaitingAnswer = false;
        options.onInTurnAvailability?.({ available: true });

        return;
      }

      if (kind === 'turn.ended') {
        flushThought();
        finishText(currentTextId);
        options.onInTurnAvailability?.({ available: false, reason: 'not_ready' });

        if (payload.reason === 'cancelled' || payload.reason === 'aborted') {
          failure = Object.assign(new Error('Ход остановлен.'), { stopped: true });
        } else if (payload.reason === 'failed' || payload.reason === 'blocked') {
          failure = kimiTurnError(payload.error ?? payload, `Ход Kimi завершился: ${payload.reason}`);
        }

        finished = true;
        notify();

        return;
      }

      if (kind === 'prompt.aborted' || kind === 'turn.step.interrupted' || kind === 'error') {
        const cancelled = kind === 'prompt.aborted'
          || (kind === 'turn.step.interrupted' && payload.reason === 'aborted');

        flushThought();
        finished = true;
        failure = cancelled
          ? Object.assign(new Error('Ход остановлен.'), { stopped: true })
          : kimiTurnError(payload.error ?? payload, `Ход Kimi завершился: ${payload.reason || 'failed'}`);
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

        // Уточнение уже принято чатом: кадры во время HTTP-доставки идут после него.
        // Ожидание ответа транспорта склеило бы их с мыслью до уточнения.
        flushThought();

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
      flushThought();
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
        throw Object.assign(failure, {
          sessionId: session.id,
          steps: stepSink.steps,
          ...lastContextUsage,
        });
      }

      await Promise.all([...writes]);

      return {
        ...lastContextUsage,
        reply,
        ...(actualModel ? { actualModel } : {}),
        assistantMessageId: replyMessageId,
        sessionId: session.id,
        steps: stepSink.steps,
      };
    } finally {
      flushThought();
      options.signal?.removeEventListener('abort', onAbort);
      stream.close();
    }
  } finally {
    await server.stop();
  }
}
