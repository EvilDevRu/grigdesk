import type { DeepSeekToolContext } from './permissions.ts';
import { deepSeekPermissionPresentation } from './permissions.ts';
import type { DeepSeekSessionObserver } from './serverTurn.ts';
import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

interface ToolRecord {
  context: DeepSeekToolContext;
  sequence: unknown;
  serialized: string;
}

/**
 * Root-адаптер использует общий scoped remote для cancel, очереди UI и lifetime waiter.
 * Здесь остаётся только корреляция канонических аргументов и явное решение человека.
 */
export function createDeepSeekToolPermissionObserver(
  sessionId: string, mode: string,
): DeepSeekSessionObserver {
  const contexts = new ToolPermissionContexts(sessionId);

  return {
    observe: (item) => {
      if (item.type === 'event') {
        contexts.note(recordOrEmpty(item.event));
      }
    },
    ready: async () => {},
    drain: async () => {},
    close: () => contexts.dispose(),
    approve: async (frame, signal) => {
      if (String(frame.agentId || '') !== sessionId || signal.aborted) {
        return { allow: false };
      }

      if (frame.event === 'user-questions/request') {
        return { question: true };
      }

      if (mode === 'read-only') {
        return { allow: false };
      }

      const request = recordOrEmpty(frame.request);

      try {
        const context = await contexts.wait({
          agentId: String(frame.agentId),
          callId: String(request.callId || ''),
          toolName: String(request.toolName || ''),
        }, signal);

        return { presentation: deepSeekPermissionPresentation({}, context, true) };
      } catch {
        return { allow: false };
      }
    },
  };
}

interface ContextWaiter {
  title: string;
  finish(context?: DeepSeekToolContext): void;
}

export class ToolPermissionContexts {
  private readonly calls = new Map<string, ToolRecord>();
  private readonly closedCalls = new Set<string>();
  private readonly waiting = new Map<string, Set<ContextWaiter>>();
  private closed = false;
  private readonly sessionId: string;
  private readonly timeoutMs: number;

  constructor(sessionId: string, timeoutMs = 5000) {
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Только живые канонические события текущего follow дают аргументы разрешению.
   * Завершение вызова и повторное использование его ID исключают старый контекст.
   */
  note(event: Record<string, unknown>): void {
    const data = event.data as Record<string, unknown> | undefined;
    const nestedSource = recordOrEmpty(recordOrEmpty(data?.message).source);
    const callId = typeof data?.callId === 'string' ? data.callId
      : typeof nestedSource.callId === 'string' ? nestedSource.callId : '';

    if (event.type === 'turn/end') {
      for (const id of new Set([...this.calls.keys(), ...this.waiting.keys()])) {
        this.retire(id);
      }

      return;
    }

    if (!callId || this.closed) {
      return;
    }

    if (event.type === 'tool/result') {
      this.retire(callId);

      return;
    }

    if (event.type !== 'tool/call') {
      return;
    }

    const previous = this.calls.get(callId);

    if (previous && previous.sequence === event.seq && previous.context.title === data?.name
      && previous.serialized === String(data?.arguments)) {
      return;
    }

    if (previous || this.closedCalls.has(callId)) {
      this.retire(callId);

      return;
    }

    try {
      const rawInput: unknown = JSON.parse(String(data?.arguments));

      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)
        || typeof data?.name !== 'string') {
        this.retire(callId);

        return;
      }

      const context = Object.freeze({ title: data.name, rawInput: Object.freeze(rawInput) });

      this.calls.set(callId, {
        context,
        sequence: event.seq,
        serialized: String(data.arguments),
      });

      for (const waiter of [...this.waiting.get(callId) || []]) {
        waiter.finish(waiter.title === context.title ? context : undefined);
      }
    } catch {
      this.retire(callId);
    }
  }

  /**
   * Ожидание относится только к доставке tool/call, а не к ответу человека.
   * Отмена снимает таймер и waiter; чужой root не может получить аргументы этого чата.
   */
  async wait(request: {
    agentId: string;
    callId: string;
    toolName: string;
  }, signal?: AbortSignal): Promise<DeepSeekToolContext> {
    if (this.closed || signal?.aborted || request.agentId !== this.sessionId
      || !request.callId || this.closedCalls.has(request.callId)) {
      throw this.failure();
    }

    const record = this.calls.get(request.callId);

    if (record) {
      if (record.context.title !== request.toolName) {
        throw this.failure();
      }

      return record.context;
    }

    return new Promise((resolve, reject) => {
      const group = this.waiting.get(request.callId) || new Set<ContextWaiter>();
      const waiter: ContextWaiter = {
        title: request.toolName,
        finish: (context) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          group.delete(waiter);

          if (!group.size) {
            this.waiting.delete(request.callId);
          }

          if (context) {
            resolve(context);
          } else {
            reject(this.failure());
          }
        },
      };
      const cancel = () => waiter.finish();
      const timer = setTimeout(cancel, this.timeoutMs);

      group.add(waiter);
      this.waiting.set(request.callId, group);
      signal?.addEventListener('abort', cancel, { once: true });

      if (signal?.aborted) {
        cancel();
      }
    });
  }

  /**
   * Снятый вызов не может появиться заново с тем же ID и старыми параметрами.
   * Копия waiter-набора позволяет каждому finish убрать себя без пропусков соседей.
   */
  private retire(callId: string): void {
    this.calls.delete(callId);
    this.closedCalls.add(callId);

    for (const waiter of [...this.waiting.get(callId) || []]) {
      waiter.finish();
    }
  }

  private failure(): Error {
    return new Error('Не удалось получить полный контекст действия DeepSeek');
  }

  /**
   * Teardown не оставляет обещаний и таймеров после закрытия native соединения.
   * Повторный dispose безопасен и не возвращает старые аргументы следующему запуску.
   */
  dispose(): void {
    this.closed = true;

    for (const id of new Set([...this.calls.keys(), ...this.waiting.keys()])) {
      this.retire(id);
    }

    this.closedCalls.clear();
  }
}
