// Веб-ход DeepSeek: Remote follow, события спросов и steer в тот же Agent loop.
import { createHash, randomUUID } from 'node:crypto';

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import type { InTurnAssistantEvent, InTurnPort } from '../../../../shared/chat/chatInTurnContracts.ts';
import type { ChatModelSource, ChatRunMetadata } from '../../../../shared/chat/chatRun.ts';
import { createStepSink } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import type { TurnFailureSignal } from '../chat/turnFailures.ts';
import { DeepSeekWebError } from './serverClient.ts';
import { deepSeekPermissionPresentation } from './permissions.ts';
import { openDeepSeekStream } from './serverEvents.ts';
import type { DeepSeekWireFrame } from './serverEvents.ts';
import { startDeepSeekServer } from './serverRuntime.ts';
import type { DeepSeekServerProcess, StartDeepSeekServerOptions } from './serverRuntime.ts';
import type { DeepSeekRuntimeDescriptor } from './runtimeProcess.ts';
import { createDeepSeekServerThoughtNormalizer } from './serverThoughts.ts';
import { dshTurnFailure } from './turnFailureRules.ts';
import { deepSeekToolResultStep, deepSeekToolStep } from './steps.ts';
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
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: 'not_ready' | 'awaiting_answer' }) => void;
  onPermission?: (presentation: Record<string, unknown>) => Promise<PermissionAnswer | null | undefined>;
  permissionMode?: string;
  factory?: boolean;
  workToolNames?: ReadonlySet<string>;
  startServer?: (options: StartDeepSeekServerOptions) => Promise<DeepSeekServerProcess>;
  onPromptAttempted?: () => void;
  variant?: DeepSeekTurnVariant;
}

// Ход другого исполнителя на той же сборке DSH. Без варианта поведение DeepSeek прежнее.
export interface DeepSeekTurnVariant {
  labels: {
    stopped: string;
    blocked: string;
    modelError: string;
    action: string;
    source: string;
  };
  // Ошибка модели из turn/end: Error — провал хода, null — сбой доставки («Продолжить ход»).
  classifyModelError: (failure: Record<string, unknown>) => Error | null;
  // Обратное чтение выбора модели по snapshot session/follow до prompt; Error — отказ.
  verifySnapshot?: (snapshot: Record<string, unknown>) => Error | null;
  // Разрешение без человека; заменяет автоодобрение DeepSeek по префиксу cockpit-work.
  autoApprove: (toolName: string) => boolean;
  // Событие хода, при котором ход нужно остановить (например, нарушена регистрация hooks).
  inspectEvent?: (event: Record<string, unknown>) => Error | null;
  // Перевод approval/request: отказ без человека либо представление для onPermission.
  approve?: (request: Record<string, unknown>) => Promise<{ allow: boolean } | {
    presentation: Record<string, unknown>;
  }>;
  // Последнее слово над ответом человека: например, отказ, если ход уже остановлен.
  settle?: (answer: PermissionAnswer | null | undefined) => PermissionAnswer;
  // Ошибка хода, который DSH заблокировал (например, hook отклонил prompt).
  blocked?: () => Error;
}

/**
 * Id блока ответа для общего хранилища: DSH строит его из attemptId вида `<сессия>:<номер>`,
 * а хранилище принимает только `[A-Za-z0-9_-]{8,80}`. Замена и хвост хэша сохраняют уникальность.
 */
export function storageMessageId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/gu, '_');

  if (safe === id && safe.length >= 8 && safe.length <= 80) {
    return safe;
  }

  const digest = createHash('sha256').update(id).digest('hex').slice(0, 12);

  return `${safe.slice(0, 67)}_${digest}`.padStart(8, '_');
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

/**
 * Модель из пары provider/model DSH — в id каталога Cockpit: JSON-пару, как у выбора модели.
 * Неполная пара значит, что DSH модель не назвал, и подтверждения нет.
 */
function catalogModelId(value: unknown): string {
  const pair = recordOrEmpty(value);

  if (typeof pair.provider !== 'string' || !pair.provider || typeof pair.model !== 'string' || !pair.model) {
    return '';
  }

  return JSON.stringify([pair.provider, pair.model]);
}

/**
 * Расход вывода за весь ход. DSH присылает `usage` один раз на запрос к модели — полный итог
 * этого запроса, поэтому итоги запросов складываются. Запрос без итога пока оценивается по
 * символам его текста и размышления; такая сумма помечается оценкой.
 */
function createTurnOutputMeter() {
  const measured = new Map<string, number>();
  const chars = new Map<string, number>();

  return {
    add(attempt: string, count: number) {
      chars.set(attempt, (chars.get(attempt) || 0) + count);
    },
    measure(attempt: string, outputTokens: number) {
      measured.set(attempt, outputTokens);
    },
    /**
     * Сумма по запросам хода: точный итог, где он пришёл, иначе оценка по символам.
     * Хоть одна оценка в сумме делает оценкой и весь счётчик.
     */
    total() {
      let tokens = 0;
      let tokensIsEstimate = false;

      for (const attempt of new Set([...chars.keys(), ...measured.keys()])) {
        const known = measured.get(attempt);

        if (known === undefined) {
          tokens += Math.round((chars.get(attempt) || 0) / 3);
          tokensIsEstimate = true;
        } else {
          tokens += known;
        }
      }

      return { tokens, tokensIsEstimate };
    },
  };
}

function blockText(value: unknown): string {
  const block = recordOrEmpty(value);
  return block.type === 'text' ? String(block.text || '') : '';
}

function assistantStreamRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(recordOrEmpty) : [];
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
      const chunk = recordOrEmpty(entry.chunk);
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
  const variant = options.variant;
  const labels = variant?.labels ?? {
    stopped: 'Ход DeepSeek остановлен.',
    blocked: 'Ход DeepSeek заблокирован.',
    modelError: 'Ошибка модели DeepSeek',
    action: 'Действие DeepSeek',
    source: 'DeepSeek',
  };
  const stoppedError = () => Object.assign(new Error(labels.stopped), { stopped: true });
  /**
   * Вариант проверяет abort после каждого ожидания до prompt: остановленный ход
   * не доходит до модели. DeepSeek прежде проверял abort только перед prompt.
   */
  const checkpoint = () => {
    if (variant && options.signal?.aborted) {
      throw stoppedError();
    }
  };
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
    checkpoint();

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

    checkpoint();
    await options.onSessionCreated?.(sessionId);
    checkpoint();
    if (options.model) {
      const selected = modelSelection(options.model);

      await server.client.rpc('session/selectModel', {
        request: {
          sessionId, ...selected,
          ...(options.effort ? { reasoningEffort: options.effort } : {}),
        },
      });
      checkpoint();
    }

    if (options.nativeSettings?.accepted.length) {
      await verifyDeepSeekNativeSettings(server.client, options.nativeSettings, options.signal);
    }

    let cancellation: Promise<void> | null = null;
    const sink = createStepSink(options.onStep);
    const thoughts = createDeepSeekServerThoughtNormalizer();
    const drafts = new Map<string, string>();
    const completed = new Set<string>();
    const abandoned = new Set<string>();
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
    // Целый сигнал сбоя (`turn/end.reason.error`), а не только текст: код причины нужен
    // реестру, чтобы решить, продолжать ход или назвать окончательный отказ.
    let deliverySignal: TurnFailureSignal | null = null;
    // Монотонный признак работы ТЕКУЩЕГО хода: настоящий вывод модели, её размышление
    // или инструмент. Внутренние повторы DSH, usage, snapshot и служебные сообщения
    // работу не подтверждают.
    let madeProgress = false;
    let wake: (() => void) | null = null;
    let eventClientId = '';
    let actualModel = '';
    const output = createTurnOutputMeter();
    const notify = () => { wake?.(); wake = null; };
    const save = (event: InTurnAssistantEvent) => {
      const write = Promise.resolve(options.onAssistantMessage?.(event));
      writes.add(write);
      write.finally(() => writes.delete(write)).catch(() => {});
    };
    /**
     * Модель, которую назвал DSH, получает снимок запуска: строка состояния перестаёт писать
     * «запр.». Повторы модуль чата отбрасывает сам, а модель ответа у него сильнее модели сессии.
     */
    const reportModel = (value: unknown, modelSource: ChatModelSource) => {
      const actualModelId = catalogModelId(value);

      if (!actualModelId) {
        return;
      }

      actualModel = actualModelId;
      options.onRunMetadata?.({ actualModelId, modelSource });
    };
    /**
     * Текст блока ответа: черновик по дельтам или завершённый блок. Завершённый и брошенный
     * блоки уже не меняются — поздняя дельта не должна переоткрыть их в окне.
     */
    const emitText = (id: string, text: string, complete: boolean) => {
      if (!id || !text || completed.has(id) || abandoned.has(id)) {
        return;
      }

      drafts.set(id, text);
      if (complete) {
        completed.add(id);
        reply = text;
        replyMessageId = id;
      }
      // Живой ответ обновляется отдельным каналом; лента удерживает один шаг блока.
      // Его объект дополняется без сотен повторных шагов в истории и SSE.
      // Id шага — тот же, что у реплики в хранилище: по нему окно прячет копию
      // показанного ответа и ставит реплику на её место среди действий.
      const step = textSteps.get(id);

      if (step) {
        step.text = text;
      } else {
        const created = sink.emit({
          k: 'text',
          id: storageMessageId(id),
          text,
        });

        if (created) {
          textSteps.set(id, created);
        }
      }

      save({
        assistantMessageId: storageMessageId(id),
        text,
        sourceRevision: text.length,
        complete,
      });
    };
    /**
     * Черновики, которые попытка уже не допишет, уходят окну с отметкой обрыва.
     * Префикс ограничивает закрытие одной попыткой; без него закрываются все открытые.
     */
    const abandonDrafts = (prefix = '') => {
      for (const [id, text] of drafts) {
        if (completed.has(id) || abandoned.has(id) || !id.startsWith(prefix)) {
          continue;
        }

        abandoned.add(id);
        save({
          assistantMessageId: storageMessageId(id),
          text,
          sourceRevision: text.length,
          complete: false,
          abandoned: true,
        });
      }
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
    /**
     * Часть live-потока попытки: размышление, дельта и конец блока ответа, итог расхода.
     * Id блока — попытка и индекс, поэтому разные попытки и блоки не склеиваются.
     */
    const handleChunk = (frame: Record<string, unknown>) => {
      const chunk = recordOrEmpty(frame.chunk);
      const attempt = String(frame.attemptId || currentAttempt);
      const id = `${attempt}-${String(chunk.index ?? '0')}`;

      sink.emitAll(thoughts(id, chunk));

      // Счётчик — расход всего хода, как у остальных исполнителей. Пометка оценки
      // передаётся всегда: модуль чата иначе оставил бы «≈» от прошлой оценки.
      if (chunk.type === 'reasoning-delta') {
        const delta = String(chunk.text || '');

        output.add(attempt, delta.length);

        if (delta.trim()) {
          madeProgress = true;
        }
      } else if (chunk.type === 'text-delta') {
        const delta = String(chunk.text || '');
        const text = `${drafts.get(id) || ''}${delta}`;

        output.add(attempt, delta.length);

        if (delta.trim()) {
          madeProgress = true;
        }

        emitText(id, text, false);

        const { tokens, tokensIsEstimate } = output.total();

        options.onProgress?.(tokens, { tokensIsEstimate });
      } else if (chunk.type === 'block-end') {
        const text = blockText(chunk.block) || drafts.get(id) || '';
        if (text) emitText(id, text, true);
      } else if (chunk.type === 'usage') {
        const usage = recordOrEmpty(chunk.usage);
        const measured = Number(usage.outputTokens);

        if (Number.isFinite(measured) && measured >= 0) {
          output.measure(attempt, measured);
        }

        const { tokens, tokensIsEstimate } = output.total();
        // Размер контекста — весь вход запроса. DSH делит его на некешированную часть и
        // кеш, поэтому один `inputTokens` при работающем кеше давал сотни токенов вместо тысяч.
        const prompt = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']
          .map((key) => Number(usage[key]) || 0)
          .reduce((sum, value) => sum + value, 0);

        options.onProgress?.(tokens, {
          tokensIsEstimate,
          ...(Number.isFinite(Number(usage.inputTokens)) ? { contextTokens: prompt } : {}),
          contextMetric: 'deepseek-web-usage',
        });
      }
    };
    /**
     * Сводит live chunks и события DSH в общую ленту и блоки ответов.
     * Граница попытки или действия закрывает накопленное размышление до следующего шага.
     */
    const handleFollow = (item: DeepSeekWireFrame) => {
      if (item.type === 'snapshot') {
        const mismatch = variant?.verifySnapshot?.(item);

        if (mismatch) {
          fail(mismatch);
        } else {
          // Обратное чтение выбора сессии до prompt: этой моделью DSH отправит запрос.
          reportModel(
            recordOrEmpty(recordOrEmpty(recordOrEmpty(item.projections).values).modelSelection).next,
            'session'
          );
        }

        return;
      }
      if (item.type === 'assistant-stream') {
        const frame = recordOrEmpty(item.frame);

        if (frame.type === 'start') {
          sink.emitAll(thoughts.flush());
          // Новая попытка отвечает с нуля: текст прежней уже не продолжится.
          abandonDrafts();
          currentAttempt = String(frame.attemptId || '');
        }
        if (frame.type === 'end') {
          // Попытка закончилась, чем бы ни кончилась: текст без block-end из неё не придёт.
          abandonDrafts(`${String(frame.attemptId || currentAttempt)}-`);
        }

        if (frame.type === 'chunk') handleChunk(frame);
        return;
      }
      if (item.type !== 'event') return;
      const event = recordOrEmpty(item.event);
      const data = recordOrEmpty(event.data);
      const violation = variant?.inspectEvent?.(event);

      if (violation) {
        fail(violation);
        cancellation ||= server.client.cancel(sessionId).catch(() => {});

        return;
      }
      if (event.type === 'turn/start') turnStarted = true;
      if (event.type === 'tool/call') {
        sink.emitAll(thoughts.flush());
        madeProgress = true;

        const name = String(data.name || 'Инструмент');
        let rawInput: unknown = {};

        try {
          rawInput = JSON.parse(String(data.arguments || '{}'));
        } catch { /* некорректные аргументы: строка ленты остаётся с именем инструмента */ }

        const callId = String(data.callId || '');

        toolContexts.set(callId, { title: name, rawInput });
        // Тот же словарь инструментов DSH, что у ACP-потока: строка ленты получает имя,
        // заголовок и команду или дифф, а не сырой JSON аргументов без подписи.
        sink.emit(deepSeekToolStep(name, rawInput, callId));
      }
      if (event.type === 'tool/result') {
        sink.emit(deepSeekToolResultStep(data));
        madeProgress = true;
      }
      if (event.type === 'assistant/message') {
        sink.emitAll(thoughts.flush());
        madeProgress = true;
        // Источник ответа — маршрут, которым DSH отправил этот запрос модели.
        reportModel(recordOrEmpty(data.message).source, 'response');

        const id = `${String(data.turn || 'turn')}-${String(data.step || 'step')}-0`;
        const text = compactText(data.stream);
        if (text && !reply) emitText(id, text, true);
      }
      if (event.type === 'turn/end' && turnStarted) {
        const reason = recordOrEmpty(data.reason);

        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          fail(stoppedError());
        } else if (reason.kind === 'error') {
          const llmFailure = recordOrEmpty(reason.error);
          const message = String(llmFailure.message || labels.modelError);
          const classified = variant ? variant.classifyModelError(llmFailure)
            : Number(llmFailure.status) === 401 || /Authentication Fails/iu.test(message)
              ? new Error(message) : null;

          if (classified) {
            fail(classified);
          } else {
            deliveryFailure = message;
            // Целый сигнал, а не только текст: код причины решает вид сбоя.
            deliverySignal = dshTurnFailure(llmFailure, labels.modelError);
            finish();
          }
        } else if (reason.kind === 'blocked') {
          fail(variant?.blocked?.() ?? new Error(labels.blocked));
        } else {
          finish();
        }
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
        const request = recordOrEmpty(item.request);
        let outcome: { kind: string; value?: unknown } = { kind: 'next' };

        if (item.event === 'approval/request') {
          const tool = String(request.toolName || labels.action);
          const automatic = variant ? variant.autoApprove(tool)
            : tool.startsWith('mcp__cockpit-work__')
              && options.workToolNames?.has(tool.slice('mcp__cockpit-work__'.length));
          const blocked = options.factory || options.permissionMode === 'read-only';
          let answer: PermissionAnswer | null | undefined;

          if (blocked || automatic) {
            answer = { allow: !blocked };
          } else if (variant?.approve) {
            // Вариант сам переводит approval: отказ без UI или своё представление человеку.
            const verdict = await variant.approve(request);

            answer = 'presentation' in verdict
              ? await options.onPermission?.({
                ...verdict.presentation,
                raw: request,
                signal: options.signal,
              })
              : verdict;
          } else {
            answer = await options.onPermission?.({
              ...deepSeekPermissionPresentation({}, toolContexts.get(String(request.callId || ''))
                || { title: tool, rawInput: {} }),
              raw: request, signal: options.signal,
            });
          }

          if (variant?.settle) {
            answer = variant.settle(answer);
          }

          outcome = { kind: 'result', value: answer?.allow === true ? 'allowed-once' : 'rejected' };
        } else {
          const questions = Array.isArray(request.questions) ? request.questions.map((value, index) => {
            const question = recordOrEmpty(value);
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
            tool: 'Вопрос агента',
            isQuestion: true,
            questions,
            acceptsText: true,
            source: labels.source,
            raw: request,
            signal: options.signal,
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
    const abort = () => {
      fail(stoppedError());
      cancellation ||= server.client.cancel(sessionId).catch(() => {});
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      await Promise.all([follow.ready, remote.ready]);
      if (options.signal?.aborted) abort();
      if (failure) throw failure;

      options.onPromptAttempted?.();
      await server.client.prompt(sessionId, options.message, randomUUID(), 'queue');

      const port: InTurnPort = {
        /**
         * Уточнение уходит в идущий ход как steer: DSH вставляет его в следующий шаг того же
         * хода. Закрытый ход и ожидание ответа на вопрос отказывают словами исполнителя.
         */
        async deliver({ messageId, text }) {
          if (finished || options.signal?.aborted) {
            return {
              ok: false,
              code: 'deepseek_turn_closed',
              message: `Активный ход ${labels.source} завершился.`,
            };
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
              ok: false,
              code: value.code || 'deepseek_steer_error',
              message: value.message || `${labels.source} не принял уточнение`,
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
        assistantMessageId: deliveryFailure || !replyMessageId ? '' : storageMessageId(replyMessageId),
        sessionId,
        steps: sink.steps,
        ...(actualModel ? { actualModel } : {}),
        ...(deliveryFailure ? {
          deliveryFailure: true,
          ...(deliverySignal ? { turnFailure: deliverySignal } : {}),
          // Разрешение продолжать — только окончательный error-исход принятого turn:
          // сбой WebSocket/RPC и неизвестное завершение сюда не попадают.
          turnRecovery: { canContinue: turnStarted, madeProgress },
          stopReason: 'error',
        } : {
          stopReason: 'completed', ...(reply ? {} : { emptyRun: true }),
        }),
      };
    } catch (error) {
      // Вариант не теряет полученное: sessionId и шаги едут вместе с ошибкой хода.
      if (variant && error && typeof error === 'object') {
        const failed = error as { sessionId?: string; steps?: unknown };

        failed.sessionId ??= sessionId;
        failed.steps ??= sink.steps;
      }

      throw error;
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
