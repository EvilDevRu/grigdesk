import { recordOrEmpty } from '../../../../shared/lib/objects.ts';
import type { DeepSeekWebClient } from './serverClient.ts';
import type { DeepSeekWireFrame } from './serverEvents.ts';

export interface RemotePermissionAnswer {
  allow?: boolean;
  rawAnswers?: Array<{
    selected?: string[];
    text?: string;
  }>;
}
/**
 * Штатный вопрос DSH преобразуется в общий контракт панели GrigDesk.
 * Это только представление: проверку владельца выполняет вызывающий до показа.
 */
export function remoteQuestions(request: Record<string, unknown>) {
  return Array.isArray(request.questions) ? request.questions.map((value, index) => {
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
}
/**
 * Pending привязан к поколению remote, eventId и собственному AbortController.
 * Отмена и поздний ответ не затрагивают соседний вопрос или новое соединение.
 */
export function createScopedRemote(options: {
  client: DeepSeekWebClient;
  signal: AbortSignal;
  source: string;
  approve: (frame: DeepSeekWireFrame, signal: AbortSignal) => Promise<{
    allow?: boolean;
    question?: boolean;
    presentation?: Record<string, unknown>;
  }>;
  onPermission?: (presentation: Record<string, unknown>)
    => Promise<RemotePermissionAnswer | null | undefined>;
  onAwaiting: (awaiting: boolean) => void;
  onFailure: (error: Error) => void;
}) {
  let clientId = '';
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, AbortController>();
  const seen = new Set<string>();
  /**
   * Панели одного чата показываются последовательно; ожидания имеют отдельные lifetime.
   * Отмена снимает панель через signal, даже если callback человека ещё не завершился.
   */
  function ask(presentation: Record<string, unknown>, signal: AbortSignal) {
    const task = queue.then(async () => {
      if (signal.aborted) {
        return undefined;
      }

      let cancel!: () => void;
      const cancelled = new Promise<undefined>((resolve) => {
        cancel = () => resolve(undefined);
        signal.addEventListener('abort', cancel, { once: true });
      });

      try {
        return await Promise.race([options.onPermission?.({ ...presentation, signal }), cancelled]);
      }
      finally {
        signal.removeEventListener('abort', cancel);
      }
    });

    queue = task.catch(() => { });

    return task;
  }
  /**
   * Все автоматические решения и вопросы проходят единую проверку native owner.
   * Ответ отправляется только в то поколение remote, которое создало pending.
   */
  async function handle(item: DeepSeekWireFrame, generation: string, controller: AbortController) {
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const eventId = String(item.eventId);
    const request = recordOrEmpty(item.request);
    const verdict = await options.approve(item, signal);
    let outcome: {
      kind: string;
      value?: unknown;
    } = { kind: 'result', value: 'rejected' };

    if (verdict.question && item.event === 'user-questions/request') {
      const questions = remoteQuestions(request);
      const answer = await ask({
        tool: 'Вопрос агента',
        isQuestion: true,
        acceptsText: true,
        questions,
        source: options.source,
        raw: request,
      }, signal);

      outcome = {
        kind: 'result',
        value: {
          answers: questions.map((question, index) => ({
            id: question.key,
            selected: answer?.rawAnswers?.[index]?.selected || [],
            ...(answer?.rawAnswers?.[index]?.text ? { custom: answer.rawAnswers[index].text } : {}),
          })),
        },
      };
    }
    else if (item.event === 'approval/request') {
      const answer = verdict.presentation
        ? await ask({ ...verdict.presentation, raw: request }, signal) : verdict;

      outcome = { kind: 'result', value: answer?.allow === true ? 'allowed-once' : 'rejected' };
    }
    else {
      outcome = {
        kind: 'rejected',
        error: { name: 'Error', message: 'Вопрос не подтвердил владельца' },
      } as typeof outcome;
    }
    if (!closed && !signal.aborted && clientId === generation) {
      await options.client.answerEvent(generation, eventId, outcome);
    }
  }

  function clear(): void {
    for (const controller of pending.values()) {
      controller.abort();
    }

    pending.clear();
    options.onAwaiting(false);
  }
  /**
   * Дубликаты не создают панель повторно, cancel завершает только свой pending.
   * ready нового поколения сначала отменяет все ожидания прежнего carrier.
   */
  function observe(item: DeepSeekWireFrame): void {
    if (closed) {
      return;
    }
    if (item.type === 'ready') {
      clear();
      clientId = String(item.clientId || '');

      return;
    }

    const id = JSON.stringify([clientId, item.eventId]);

    if (item.type === 'cancel') {
      pending.get(id)?.abort();
      pending.delete(id);
      options.onAwaiting(pending.size > 0);

      return;
    }
    if (item.type !== 'waterfall' || !clientId || !item.eventId || seen.has(id)
      || !['approval/request', 'user-questions/request'].includes(String(item.event))) {
      return;
    }

    const controller = new AbortController();

    seen.add(id);
    pending.set(id, controller);
    options.onAwaiting(true);
    void handle(item, clientId, controller).catch((error) => {
      if (!closed && !controller.signal.aborted && !options.signal.aborted) {
        options.onFailure(error);
      }
    }).finally(() => {
      pending.delete(id);
      options.onAwaiting(pending.size > 0);
    });
  }

  return {
    observe,
    close() {
      closed = true;
      clear();
    },
  };
}
