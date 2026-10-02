// Веб-ход DeepSeek: Remote follow, события спросов и steer в тот же Agent loop.
import { randomUUID } from 'node:crypto';

import type { InTurnAssistantEvent, InTurnPort } from '../../../../shared/chatInTurnContracts.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { DeepSeekWebError } from './serverClient.ts';
import { deepSeekPermissionPresentation } from './permissions.ts';
import { openDeepSeekStream } from './serverEvents.ts';
import type { DeepSeekWireFrame } from './serverEvents.ts';
import { startDeepSeekServer } from './serverRuntime.ts';
import type { DeepSeekServerProcess, StartDeepSeekServerOptions } from './serverRuntime.ts';
import type { DeepSeekRuntimeDescriptor } from './runtimeProcess.ts';
import { createDeepSeekServerThoughtNormalizer } from './serverThoughts.ts';
import type { PreparedNativeSettings } from '../executorSettings/types.ts';
import {
  applyDeepSeekNativeSettings,
  deepSeekSettingsNeedRestart,
  verifyDeepSeekNativeSettings,
} from '../executorSettings/deepseek.ts';

type PermissionAnswer = {
  allow?: boolean;
  rawAnswers?: Array<{ selected?: string[]; text?: string }>;
};

export interface DeepSeekServerTurnOptions {
  bin: string;
  runtime?: DeepSeekRuntimeDescriptor;
  overlayPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeSettings?: PreparedNativeSettings;
  message: string;
  sessionId?: string | null;
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  onStep?: (step: ChatStep) => void;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: 'not_ready' | 'awaiting_answer' }) => void;
  onPermission?: (presentation: Record<string, unknown>) => Promise<PermissionAnswer | null | undefined>;
  permissionMode?: string;
  factory?: boolean;
  workToolNames?: ReadonlySet<string>;
  startServer?: (options: StartDeepSeekServerOptions) => Promise<DeepSeekServerProcess>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** ACP-каталог сохраняет модель как JSON-пару provider/model; web RPC ждёт два поля. */
function modelSelection(value: string): { provider: string; model: string } {
  let pair: unknown;

  try {
    pair = JSON.parse(value);
  } catch {
    throw new DeepSeekWebError('Некорректный id модели DeepSeek', 'deepseek_model_invalid');
  }

  if (!Array.isArray(pair) || pair.length !== 2
    || typeof pair[0] !== 'string' || !pair[0]
    || typeof pair[1] !== 'string' || !pair[1]) {
    throw new DeepSeekWebError('Некорректный id модели DeepSeek', 'deepseek_model_invalid');
  }

  return { provider: pair[0], model: pair[1] };
}

function blockText(value: unknown): string {
  const block = record(value);
  return block.type === 'text' ? String(block.text || '') : '';
}

function assistantStreamRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

/**
 * Штатный `assistant/message` хранит компактные серии дельт. При повторном чтении
 * достаточно `block-end` и text-chunks: id блока остаётся тем же, что у live frame.
 */
function compactText(stream: unknown): string {
  let text = '';
  for (const entry of assistantStreamRecords(stream)) {
    if (entry.type === 'text-chunks' && Array.isArray(entry.texts)) {
      text += entry.texts.map(String).join('');
    } else if (entry.type === 'chunk') {
      const chunk = record(entry.chunk);
      if (chunk.type === 'text-delta') text += String(chunk.text || '');
      if (chunk.type === 'block-end') text = blockText(chunk.block) || text;
    }
  }
  return text;
}

/**
 * Запускает web-процесс выбранного поколения и завершает его вместе с ходом.
 * Настройки принимаются до session/prompt; private URL остаётся внутри клиента.
 */
export async function runDeepSeekServerTurn(options: DeepSeekServerTurnOptions) {
  const start = () => (options.startServer || startDeepSeekServer)({
    runtime: options.runtime,
    bin: options.bin,
    overlayPath: options.overlayPath,
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
  });
  let server = await start();

  try {
    if (options.nativeSettings?.accepted.length) {
      const restart = await deepSeekSettingsNeedRestart(server.client, options.nativeSettings);

      await applyDeepSeekNativeSettings(server.client, options.nativeSettings, options.signal);

      if (restart) {
        await server.stop();
        server = await start();
      }

      await verifyDeepSeekNativeSettings(server.client, options.nativeSettings, options.signal);
    }

    const sessionId = await server.client.createSession(options.cwd, options.sessionId);
    await options.onSessionCreated?.(sessionId);
    if (options.model) {
      const selected = modelSelection(options.model);

      await server.client.rpc('session/selectModel', {
        request: {
          sessionId, ...selected,
          ...(options.effort ? { reasoningEffort: options.effort } : {}),
        },
      });
    }

    if (options.nativeSettings?.accepted.length) {
      await verifyDeepSeekNativeSettings(server.client, options.nativeSettings, options.signal);
    }

    const sink = createStepSink(options.onStep);
    const thoughts = createDeepSeekServerThoughtNormalizer();
    const drafts = new Map<string, string>();
    const completed = new Set<string>();
    const textSteps = new Map<string, Record<string, unknown>>();
    const toolContexts = new Map<string, { title: string; rawInput: unknown }>();
    const writes = new Set<Promise<void>>();
    let currentAttempt = '';
    let reply = '';
    let replyMessageId = '';
    let turnStarted = false;
    let finished = false;
    let awaitingAnswer = false;
    let failure: Error | null = null;
    let deliveryFailure = '';
    let wake: (() => void) | null = null;
    let eventClientId = '';
    let producedChars = 0;
    const notify = () => { wake?.(); wake = null; };
    const save = (event: InTurnAssistantEvent) => {
      const write = Promise.resolve(options.onAssistantMessage?.(event));
      writes.add(write);
      write.finally(() => writes.delete(write)).catch(() => {});
    };
    const emitText = (id: string, text: string, complete: boolean) => {
      if (!id || !text || completed.has(id)) return;
      drafts.set(id, text);
      if (complete) {
        completed.add(id);
        reply = text;
        replyMessageId = id;
      }
      // Живой ответ обновляется отдельным каналом; лента удерживает один шаг блока.
      // Его объект дополняется без сотен повторных шагов в истории и SSE.
      const step = textSteps.get(id);

      if (step) {
        step.text = text;
      } else {
        const created = sink.emit({ k: 'text', id, text });

        if (created) {
          textSteps.set(id, created);
        }
      }

      save({ assistantMessageId: id, text, sourceRevision: text.length, complete });
    };
    /**
     * Ошибка закрывает ход и сохраняет уже полученное размышление в ленте.
     * Повторное закрытие сокета после завершения не меняет результат хода.
     */
    const fail = (error: Error) => {
      if (finished) {
        return;
      }

      sink.emitAll(thoughts.flush());
      failure = error;
      finished = true;
      notify();
    };
    /**
     * Завершение отдаёт хвост размышления, даже когда DSH не прислал block-end.
     * Канал уточнений закрывается вместе с исходным ходом, до возврата результата.
     */
    const finish = () => {
      if (finished) {
        return;
      }

      sink.emitAll(thoughts.flush());
      finished = true;
      options.onInTurnAvailability?.({ available: false, reason: 'not_ready' });
      notify();
    };
    const setAwaiting = (value: boolean) => {
      awaitingAnswer = value;
      options.onInTurnAvailability?.(value
        ? { available: false, reason: 'awaiting_answer' }
        : { available: true });
    };
    const handleChunk = (frame: Record<string, unknown>) => {
      const chunk = record(frame.chunk);
      const id = `${String(frame.attemptId || currentAttempt)}-${String(chunk.index ?? '0')}`;

      sink.emitAll(thoughts(id, chunk));

      if (chunk.type === 'text-delta') {
        const delta = String(chunk.text || '');
        const text = `${drafts.get(id) || ''}${delta}`;
        producedChars += delta.length;
        emitText(id, text, false);
        options.onProgress?.(Math.round(producedChars / 3), { tokensIsEstimate: true });
      } else if (chunk.type === 'block-end') {
        const text = blockText(chunk.block) || drafts.get(id) || '';
        if (text) emitText(id, text, true);
      } else if (chunk.type === 'usage') {
        const usage = record(chunk.usage);
        options.onProgress?.(Number(usage.outputTokens) || Math.round(producedChars / 3), {
          ...(Number.isFinite(Number(usage.inputTokens)) ? { contextTokens: Number(usage.inputTokens) } : {}),
          contextMetric: 'deepseek-web-usage',
        });
      }
    };
    /**
     * Сводит live chunks и события DSH в общую ленту и блоки ответов.
     * Граница попытки или действия закрывает накопленное размышление до следующего шага.
     */
    const handleFollow = (item: DeepSeekWireFrame) => {
      if (item.type === 'assistant-stream') {
        const frame = record(item.frame);

        if (frame.type === 'start') {
          sink.emitAll(thoughts.flush());
          currentAttempt = String(frame.attemptId || '');
        }

        if (frame.type === 'chunk') handleChunk(frame);
        return;
      }
      if (item.type !== 'event') return;
      const event = record(item.event);
      const data = record(event.data);
      if (event.type === 'turn/start') turnStarted = true;
      if (event.type === 'tool/call') {
        sink.emitAll(thoughts.flush());

        const name = String(data.name || 'Инструмент');
        let rawInput: unknown = {};

        try {
          rawInput = JSON.parse(String(data.arguments || '{}'));
        } catch { /* некорректные аргументы остаются текстом шага */ }

        toolContexts.set(String(data.callId || ''), { title: name, rawInput });
        sink.emit({
          k: 'tool', id: String(data.callId || ''), tool: name,
          kind: name === 'bash' ? 'execute' : name.startsWith('mcp__') ? 'mcp' : 'other',
          text: String(data.arguments || name),
        });
      }
      if (event.type === 'tool/result') {
        const message = record(data.message);
        sink.emit({
          k: 'res', id: String(message.toolCallId || ''), ok: message.isError !== true,
          text: JSON.stringify(message.content || []),
        });
      }
      if (event.type === 'assistant/message') {
        sink.emitAll(thoughts.flush());

        const id = `${String(data.turn || 'turn')}-${String(data.step || 'step')}-0`;
        const text = compactText(data.stream);
        if (text && !reply) emitText(id, text, true);
      }
      if (event.type === 'turn/end' && turnStarted) {
        const reason = record(data.reason);
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          fail(Object.assign(new Error('Ход DeepSeek остановлен.'), { stopped: true }));
        } else if (reason.kind === 'error') {
          const llmFailure = record(reason.error);
          const message = String(llmFailure.message || 'Ошибка модели DeepSeek');
          if (Number(llmFailure.status) === 401 || /Authentication Fails/iu.test(message)) {
            fail(new Error(message));
          } else {
            deliveryFailure = message;
            finish();
          }
        } else if (reason.kind === 'blocked') {
          fail(new Error('Ход DeepSeek заблокирован.'));
        } else finish();
      }
    };
    const handleRemote = (item: DeepSeekWireFrame) => {
      if (item.type === 'ready') {
        eventClientId = String(item.clientId || '');
        return;
      }
      if (item.type !== 'waterfall') return;
      if (item.event !== 'approval/request' && item.event !== 'user-questions/request') return;
      setAwaiting(true);
      void (async () => {
        const request = record(item.request);
        let outcome: { kind: string; value?: unknown } = { kind: 'next' };
        if (item.event === 'approval/request') {
          const tool = String(request.toolName || 'Действие DeepSeek');
          const answer = options.factory || options.permissionMode === 'read-only'
            ? { allow: false }
            : tool.startsWith('mcp__cockpit-work__')
              && options.workToolNames?.has(tool.slice('mcp__cockpit-work__'.length))
              ? { allow: true }
              : await options.onPermission?.({
                ...deepSeekPermissionPresentation({}, toolContexts.get(String(request.callId || ''))
                  || { title: tool, rawInput: {} }),
                raw: request, signal: options.signal,
              });
          outcome = { kind: 'result', value: answer?.allow === true ? 'allowed-once' : 'rejected' };
        } else {
          const questions = Array.isArray(request.questions) ? request.questions.map((value, index) => {
            const question = record(value);
            return {
              key: String(question.id || `q_${index}`),
              header: String(question.header || `Вопрос ${index + 1}`),
              question: String(question.question || ''),
              options: Array.isArray(question.options) ? question.options : [],
              multiSelect: question.multiSelect === true,
              allowFreeText: true,
            };
          }) : [];
          const answer = await options.onPermission?.({
            tool: 'Вопрос агента', isQuestion: true, questions,
            acceptsText: true, source: 'DeepSeek', raw: request, signal: options.signal,
          });
          outcome = { kind: 'result', value: {
            answers: questions.map((question, index) => ({
              id: question.key,
              selected: answer?.rawAnswers?.[index]?.selected || [],
              ...(answer?.rawAnswers?.[index]?.text
                ? { custom: answer.rawAnswers[index].text } : {}),
            })),
          } };
        }
        await server.client.answerEvent(eventClientId, String(item.eventId || ''), outcome);
        setAwaiting(false);
      })().catch(fail);
    };
    const follow = openDeepSeekStream({
      client: server.client, endpoint: 'session/follow',
      args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } },
      onItem: handleFollow, onClose: fail,
    });
    const remote = openDeepSeekStream({
      client: server.client, endpoint: '$events', args: {},
      onItem: handleRemote, onClose: fail,
    });
    let cancellation: Promise<void> | null = null;
    const abort = () => {
      fail(Object.assign(new Error('Ход DeepSeek остановлен.'), { stopped: true }));
      cancellation ||= server.client.cancel(sessionId).catch(() => {});
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.all([follow.ready, remote.ready]);
      if (options.signal?.aborted) abort();
      if (failure) throw failure;
      await server.client.prompt(sessionId, options.message, randomUUID(), 'queue');
      const port: InTurnPort = {
        async deliver({ messageId, text }) {
          if (finished || options.signal?.aborted) {
            return { ok: false, code: 'deepseek_turn_closed', message: 'Активный ход DeepSeek завершился.' };
          }
          if (awaitingAnswer) {
            return { ok: false, code: 'awaiting_answer', message: 'Агент ждёт ответа на вопрос.' };
          }
          try {
            await server.client.prompt(sessionId, text, messageId, 'steer');
            return { ok: true, state: 'forwarded' };
          } catch (error) {
            const value = error as DeepSeekWebError;
            return {
              ok: false, code: value.code || 'deepseek_steer_error',
              message: value.message || 'DeepSeek не принял уточнение',
              ...(value.uncertain ? { uncertain: true } : {}),
            };
          }
        },
        close() {},
      };
      if (!finished) {
        options.onInTurnReady?.(port);
        options.onInTurnAvailability?.(awaitingAnswer
          ? { available: false, reason: 'awaiting_answer' } : { available: true });
      }
      while (!finished) {
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 200); });
      }
      if (failure) throw failure;
      await Promise.all([...writes]);
      return {
        reply: deliveryFailure || reply,
        assistantMessageId: deliveryFailure ? '' : replyMessageId,
        sessionId,
        steps: sink.steps,
        ...(deliveryFailure ? { deliveryFailure: true, stopReason: 'error' } : {
          stopReason: 'completed', ...(reply ? {} : { emptyRun: true }),
        }),
      };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (cancellation) await cancellation;
      follow.close();
      remote.close();
    }
  } finally {
    await server.stop();
  }
}
