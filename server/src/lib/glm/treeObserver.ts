import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import { openDeepSeekStream } from '../deepseek/serverEvents.ts';
import type { DeepSeekWireFrame } from '../deepseek/serverEvents.ts';
import type { DeepSeekWebClient } from '../deepseek/serverClient.ts';
import { deepSeekToolResultStep, deepSeekToolStep } from '../deepseek/steps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { createGlmNativeGuard } from './nativeGuard.ts';
import type { NativeGateIdentity } from './nativeGuard.ts';
import { glmAccessError } from './env.ts';
import { createGlmChildPresentation } from './childPresentation.ts';

interface SessionState {
  id: string;
  address: Record<string, unknown>;
  parent?: string;
  cursor: number;
  terminal: boolean;
  queue: Promise<void>;
  close?: () => void;
  presentation?: ReturnType<typeof createGlmChildPresentation>;
}
/**
 * Id ребёнка имеет отдельное пространство; корневые id сохраняют прежний контракт ленты.
 * Хэш не содержит путей, текста или аргументов модели.
 */
function childStepId(sessionId: string, turn: unknown, id: unknown): string {
  return `glm_${createHash('sha256').update(JSON.stringify([sessionId, turn, id])).digest('hex')}`;
}
/**
 * Наблюдает только проверенные рёбра текущего foreground дерева.
 * Полный журнал восстанавливается до live suffix, сохраняя изоляцию root reply и context.
 */
export function createGlmTreeObserver(options: NativeGateIdentity & {
  client: DeepSeekWebClient;
  sessionId: string;
  signal: AbortSignal;
  workTools: readonly string[];
  onStep: (step: ChatStep) => void;
  onProgress: (tokens: number) => void;
  onFailure: (error: Error) => void;
  openStream?: typeof openDeepSeekStream;
}) {
  const guard = createGlmNativeGuard({ ...options, rootSessionId: options.sessionId });
  const states = new Map<string, SessionState>();
  const links = new Map<string, Record<string, unknown>>();
  const catalog = new Map<string, string>();
  let closed = false;
  let tokens = 0;
  let failure: Error | undefined;
  const root: SessionState = {
    id: options.sessionId,
    address: { kind: 'session', sessionId: options.sessionId },
    cursor: -1,
    terminal: false,
    queue: Promise.resolve(),
  };

  states.set(root.id, root);
  /**
   * Ошибка наблюдения не разрешает повторить уже отправленный prompt.
   * Внешний owner отменит корень и завершит принадлежащий ему runtime.
   */
  function fail(error: unknown): void {
    if (closed || failure) {
      return;
    }

    failure = error instanceof Error ? error : new Error(String(error));
    options.onFailure(failure);
  }
  /**
   * Открывает follow лишь после совпадения native ссылки с каталогом родителя.
   * Дети прошлого launch остаются историей и не получают новую подписку исполнения.
   */
  function discover(): void {
    for (const [childId, link] of links) {
      if (states.has(childId) || catalog.get(childId) !== link.parentSessionId) {
        continue;
      }

      const parent = states.get(String(link.parentSessionId));

      if (!parent || childId === root.id || link.mode !== 'one-shot') {
        throw new Error('Повреждена родительская связь GLM');
      }

      const parentCall = parent.id === root.id ? String(link.parentCallId)
        : childStepId(parent.id, link.parentTurn, link.parentCallId);
      const state: SessionState = {
        id: childId,
        address: {
          kind: 'subagent',
          parentSessionId: parent.id,
          childSessionId: childId,
          mode: 'one-shot',
        },
        parent: parentCall,
        cursor: -1,
        terminal: false,
        queue: Promise.resolve(),
      };

      states.set(childId, state);
      state.presentation = createGlmChildPresentation({
        id: (turn, id) => childStepId(childId, turn, id),
        emit: (step) => options.onStep({ ...step, parent: parentCall }),
        usage: (value) => {
          tokens += value;
          options.onProgress(tokens);
        },
      });

      const stream = (options.openStream ?? openDeepSeekStream)({
        client: options.client,
        endpoint: 'session/follow',
        args: { request: { address: state.address, assistantStream: true } },
        onItem: (item) => enqueue(state, item),
        onClose: (error) => {
          if (!state.terminal) {
            fail(error);
          }
        },
      });

      state.close = stream.close;
      void stream.ready.catch(fail);
    }
  }
  /**
   * Дочерняя лента получает только события после native ready текущего launch.
   * Каждая session ведёт cursor; унаследованный seed не публикуется вторично.
   */
  function event(state: SessionState, raw: Record<string, unknown>, replay: boolean): void {
    const seq = Number(raw.seq);

    if (!Number.isSafeInteger(seq) || seq <= state.cursor) {
      return;
    }
    if (seq !== state.cursor + 1) {
      throw new Error('В потоке GLM пропущено событие');
    }

    state.cursor = seq;
    guard.inspect(state.id, raw);

    const data = recordOrEmpty(raw.data);

    if (raw.type === 'grigdesk/glm-delegation' && data.launchId === options.launchId
      && guard.isReady(state.id)) {
      if (data.parentSessionId !== state.id || typeof data.childSessionId !== 'string'
        || typeof data.parentCallId !== 'string' || !Number.isSafeInteger(data.parentTurn)
        || data.version !== 1 || data.mode !== 'one-shot' || links.has(data.childSessionId)
        || states.has(data.childSessionId)
        || !guard.isDelegation(state.id, Number(data.parentTurn), data.parentCallId)) {
        throw new Error('Повреждён дескриптор делегирования GLM');
      }

      links.set(data.childSessionId, data);
    }
    if (raw.type === 'subagent/catalog' && guard.isReady(state.id)) {
      catalog.set(String(data.childId), state.id);
    }

    discover();

    if (!guard.isReady(state.id) || state.id === root.id) {
      return;
    }

    const emit = (step: ChatStep) => options.onStep({ ...step, parent: state.parent });
    const stepId = (id: unknown) => childStepId(state.id, data.turn, id);

    if (raw.type === 'tool/call') {
      emit(deepSeekToolStep(String(data.name), JSON.parse(String(data.arguments)), stepId(data.callId)));
    }
    if (raw.type === 'tool/result') {
      const step = deepSeekToolResultStep(data);

      emit({ ...step, id: stepId(step.id) });
    }
    if (raw.type === 'assistant/message' || raw.type === 'assistant/attempt') {
      state.presentation?.message(data);
    }
    if (raw.type === 'turn/end') {
      state.presentation?.flush();
      state.terminal = true;
    }
  }
  /**
   * Snapshot ограничен страницей: ранние записи догружаются при неизменном cursor cut.
   * Очередь удерживает live suffix до окончания пагинации, без гонки двух обработчиков.
   */
  async function consume(state: SessionState, item: DeepSeekWireFrame): Promise<void> {
    if (item.type === 'snapshot') {
      const header = recordOrEmpty(item.header);

      if (header.id !== state.id) {
        throw new Error('Подписка GLM вернула другую сессию');
      }

      let records = Array.isArray(item.records) ? item.records.map(recordOrEmpty) : [];
      let more = item.hasMore === true;
      const cursor = Number(item.cursor);

      while (more) {
        const beforeSeq = Number(recordOrEmpty(records[0]?.event).seq);
        const page = recordOrEmpty(await options.client.rpc('session/page', {
          request: {
            address: state.address,
            throughSeq: cursor,
            beforeSeq,
            maxMessages: 100
          },
        }, 30000, options.signal));
        const previous = Array.isArray(page.records) ? page.records.map(recordOrEmpty) : [];

        if (!previous.length || Number(recordOrEmpty(previous[0]?.event).seq) >= beforeSeq) {
          throw new Error('История GLM не продвигается при чтении');
        }

        records = [...previous, ...records];
        more = page.hasMore === true;
      }
      for (const record of records) {
        event(state, recordOrEmpty(record.event), true);
      }

      if (!Number.isSafeInteger(cursor) || cursor !== state.cursor) {
        throw new Error('Snapshot GLM содержит неполную историю');
      }

      const values = recordOrEmpty(recordOrEmpty(item.projections).values);
      const entries = Array.isArray(values.subagentCatalog) ? values.subagentCatalog.map(recordOrEmpty) : [];

      for (const entry of entries) {
        catalog.set(String(entry.id), state.id);
      }

      discover();

      if (guard.isReady(state.id)) {
        state.presentation?.baseline(recordOrEmpty(item.assistantStream).activeAttempt);
      }
    }
    else if (item.type === 'event') {
      event(state, recordOrEmpty(item.event), false);
    } else if (item.type === 'assistant-stream' && guard.isReady(state.id)) {
      state.presentation?.frame(recordOrEmpty(item.frame));
    }
  }

  function enqueue(state: SessionState, item: DeepSeekWireFrame): Promise<void> {
    state.queue = state.queue.then(() => consume(state, item)).catch(fail);

    return state.queue;
  }
  /**
   * До prompt ждём только ready текущего launch, а не старую запись resume.
   * Отсутствующий plugin обнаруживает сервер независимо от самого plugin.
   */
  async function ready(): Promise<void> {
    const deadline = Date.now() + 10000;

    while (!guard.isReady(root.id) && !failure && !options.signal.aborted && Date.now() < deadline) {
      await pause(20);
    }

    if (failure) {
      throw failure;
    }
    if (options.signal.aborted) {
      throw Object.assign(new Error('GLM остановлен'), { stopped: true });
    }
    if (!guard.isReady(root.id)) {
      throw glmAccessError('glm_policy_gate_missing', 'Runtime GLM не подтвердил обязательную проверку.');
    }
  }
  /**
   * Foreground root завершается после dispose детей, но follow может отставать.
   * Возврат результата ждёт их terminal suffix и сохранения всех дочерних steps.
   */
  async function drain(): Promise<void> {
    const deadline = Date.now() + 30000;

    while (!failure && !options.signal.aborted && Date.now() < deadline) {
      await Promise.all([...states.values()].map((state) => state.queue));

      if ([...states.values()].every((state) => state === root || state.terminal)
        && [...links.keys()].every((id) => states.has(id))) {
        return;
      }

      await pause(20);
    }

    throw failure ?? glmAccessError('glm_tree_incomplete', 'Не подтверждено завершение дерева GLM.');
  }

  return {
    observe: (item: DeepSeekWireFrame) => enqueue(root, item),
    approve: guard.approve,
    ready,
    drain,
    close() {
      closed = true;

      for (const state of states.values()) {
        state.close?.();
      }
    },
  };
}
