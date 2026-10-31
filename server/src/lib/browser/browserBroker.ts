import { randomUUID, timingSafeEqual } from 'node:crypto';
import { parseBrowserAction } from '../../../../shared/browser/browserActions.ts';

interface Command {
  requestId: string;
  hostEpoch: number;
  owner: string;
  deadline: number;
  action: string;
  tabId?: string;
  [field: string]: unknown;
}

interface Pending {
  command: Command;
  resolve(value: unknown): void;
  reject(error: Error): void;
  dispatched: boolean;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
  validate(): Promise<boolean>;
}

/**
 * Брокер отделяет запуск модели от доступного desktop-клиента и его lease.
 * Команда исчезает из очереди после выдачи и никогда автоматически не исполняется повторно.
 */
export function createBrowserBroker(options: {
  now?: () => number;
  id?: () => string;
  validateOwner(owner: string): Promise<boolean>;
}) {
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const requests = new Map<string, Pending>();
  const completed = new Set<string>();
  const wake = new Set<() => void>();
  let host: {
    id: string;
    token: string;
    epoch: number;
    until: number
  } | null = null;
  let generation = 0;
  let polling = false;
  let closed = false;

  const changed = () => {
    for (const listener of [...wake]) {
      listener();
    }
  };
  /**
   * Завершение снимает запрос, таймер и abort listener до публикации результата.
   * Освобождённая вкладка сразу будит ожидающий poll следующей команды.
   */
  const finish = (request: Pending, value: unknown, error?: string) => {
    requests.delete(request.command.requestId);
    clearTimeout(request.timer);
    request.cleanup();

    if (error) {
      request.reject(new Error(error));
    } else {
      request.resolve(value);
    }

    changed();
  };
  /**
   * Смена поколения снимает прежнего host и все его pending запросы.
   * Выданные команды завершаются неизвестным исходом без автоматического повтора.
   */
  const revoke = () => {
    host = null;
    generation += 1;

    for (const request of [...requests.values()]) {
      finish(request, null, request.dispatched ? 'outcome_unknown' : 'browser_unavailable');
    }

    changed();
  };
  /**
   * Host подтверждает текущую identity и token с постоянным временем сравнения.
   * Истёкшая lease отзывает очередь до возврата именованного отказа.
   */
  const check = (hostId: string, token: string) => {
    const current = host;

    if (!current || hostId !== current.id || token.length !== current.token.length
      || !timingSafeEqual(Buffer.from(token), Buffer.from(current.token))) {
      throw new Error('host_forbidden');
    }

    if (current.until <= now()) {
      revoke();

      throw new Error('host_expired');
    }

    return current;
  };

  /**
   * Модельные и ручные команды используют одну bounded очередь и общий lifecycle.
   * Только публичный invoke разбирает model action; manual grant создаётся отдельным control.
   */
  const enqueue = async (owner: string, input: Record<string, unknown> & { action: string },
    signal: AbortSignal | undefined,
    authorize: (() => Promise<boolean>) | undefined, metadata: { grantEpoch: number },
  ) => {
      const epoch = generation;
      const validate = async () => await options.validateOwner(owner)
        && (!authorize || await authorize());

      if (!await validate()) {
        throw new Error('browser_owner_forbidden');
      }

      if (!host || host.until <= now() || epoch !== generation || closed || signal?.aborted) {
        throw new Error('browser_unavailable');
      }

      if (requests.size >= 32) {
        throw new Error('browser_queue_full');
      }

      const command: Command = {
        ...input,
        requestId: id(),
        hostEpoch: host.epoch,
        owner,
        deadline: now() + 15000,
        hostId: host.id,
        grantEpoch: metadata.grantEpoch,
      };

      return new Promise<unknown>((resolve, reject) => {
        const onAbort = () => finish(request, null,
          request.dispatched ? 'outcome_unknown' : 'browser_cancelled');
        const request: Pending = {
          command,
          resolve,
          reject,
          dispatched: false,
          validate,
          timer: setTimeout(() => finish(request, null,
            request.dispatched ? 'outcome_unknown' : 'browser_timeout'), 15000),
          cleanup: () => signal?.removeEventListener('abort', onAbort),
        };

        request.timer.unref?.();
        requests.set(command.requestId, request);
        signal?.addEventListener('abort', onAbort, { once: true });
        changed();
      });
  };

  return {
    generation: () => generation,
    available: () => !closed && host !== null && host.until > now(),
    /**
     * Живой host уступает управление только при явном takeover.
     * Любая успешная регистрация создаёт новое поколение и отдельный token.
     */
    register(input: { takeover?: boolean } = {}) {
      if (closed) {
        throw new Error('browser_unavailable');
      }

      if (host && host.until > now() && !input.takeover) {
        throw new Error('browser_host_conflict');
      }

      revoke();
      host = {
        id: id(),
        token: id(),
        epoch: generation,
        until: now() + 15000
      };

      return {
        id: host.id,
        token: host.token,
        hostEpoch: host.epoch
      };
    },
    heartbeat(hostId: string, token: string) {
      check(hostId, token).until = now() + 15000;
    },
    /**
     * После асинхронной проверки владельца повторно проверяется поколение host.
     * Отмена уже выданной команды сообщает неизвестный исход без повторного клика.
     */
    invoke(owner: string, raw: unknown, signal?: AbortSignal, authorize?: () => Promise<boolean>,
      metadata: { grantEpoch: number } = { grantEpoch: 0 },
    ) {
      return enqueue(owner, parseBrowserAction(raw), signal, authorize, metadata);
    },
    control(owner: string, input: {
      tabId: string;
      pageEpoch: number;
      grantEpoch: number;
    }) {
      return enqueue(owner, {
        action: 'grant',
        human: true,
        tabId: input.tabId,
        pageEpoch: input.pageEpoch,
        grantEpoch: input.grantEpoch,
      }, undefined, undefined, { grantEpoch: input.grantEpoch });
    },
    assertHost(hostId: string, token: string) {
      check(hostId, token);
    },
    hostId: () => host?.id ?? null,
    /**
     * Один poll обслуживает один host и выдаёт только ещё не исполненную команду.
     * Разные вкладки не блокируют друг друга, одна вкладка сохраняет последовательность.
     */
    async poll(hostId: string, token: string, signal?: AbortSignal): Promise<Command | null> {
      const current = check(hostId, token);

      if (polling) {
        throw new Error('browser_poll_conflict');
      }

      polling = true;

      try {
        while (!signal?.aborted) {
          check(hostId, token);

          const busy = new Set([...requests.values()]
            .filter((request) => request.dispatched).map((request) => request.command.tabId));
          const request = [...requests.values()].find((item) => !item.dispatched
            && (!item.command.tabId || !busy.has(item.command.tabId)));

          if (request) {
            const valid = await request.validate();

            check(hostId, token);

            if (!requests.has(request.command.requestId) || current.epoch !== generation) {
              continue;
            }

            if (!valid) {
              finish(request, null, 'browser_owner_forbidden');

              continue;
            }

            request.dispatched = true;

            return {
              ...structuredClone(request.command),
              remainingMs: Math.max(0, request.command.deadline - now()),
            };
          }

          const timeout = await new Promise<boolean>((resolve) => {
            /**
             * Завершение ожидания poll снимает таймер и оба канала пробуждения.
             * Отмена и timeout не оставляют listener на следующий запрос.
             */
            const done = (timedOut = false) => {
              clearTimeout(timer);
              wake.delete(done);
              signal?.removeEventListener('abort', aborted);
              resolve(timedOut);
            };
            const aborted = () => done(false);
            const timer = setTimeout(() => done(true), 20000);

            wake.add(done);
            signal?.addEventListener('abort', aborted, { once: true });
          });

          if (timeout) {
            return null;
          }
        }

        return null;
      } finally {
        polling = false;
      }
    },
    /**
     * ACK относится только к выданному запросу текущего поколения host.
     * После повторной проверки proof завершение публикуется ровно один раз.
     */
    result(hostId: string, token: string, requestId: string, value: unknown) {
      const current = check(hostId, token);

      if (completed.has(requestId)) {
        return Promise.resolve();
      }

      const request = requests.get(requestId);

      if (!request?.dispatched || request.command.hostEpoch !== current.epoch) {
        throw new Error('browser_result_unknown');
      }

      return request.validate().then((valid) => {
        check(hostId, token);

        if (!valid || requests.get(requestId) !== request || current.epoch !== generation) {
          throw new Error('browser_owner_forbidden');
        }

        completed.add(requestId);

        if (completed.size > 128) {
          completed.delete(completed.values().next().value!);
        }

        finish(request, value);
      });
    },
    unregister(hostId: string, token: string) {
      check(hostId, token);
      revoke();
    },
    close() {
      closed = true;
      revoke();
    },
  };
}
