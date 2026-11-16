import type {

  BrowserGrantInput,
  BrowserHostStatus,
  BrowserOwnerChoice,
} from './browserUi.ts';


export interface BrowserHostIdentity {
  id: string;
  token: string;
  hostEpoch: number;
  leaseMs: number;
}

export interface BrowserCommand {
  requestId: string;
  hostId: string;
  hostEpoch: number;
  remainingMs: number;
  action: string;
  [key: string]: unknown;
}

interface CachedCommand {
  fingerprint: string;
  result: Promise<unknown>;
  expires: number;
  settled: boolean;
}

export type BrowserCommandCache = Map<string, CachedCommand>;

interface HostPort {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  register(takeover: boolean, signal: AbortSignal): Promise<BrowserHostIdentity>;
  heartbeat(host: BrowserHostIdentity, projection: unknown,
    signal: AbortSignal): Promise<{ leaseMs: number }>;
  poll(host: BrowserHostIdentity, signal: AbortSignal): Promise<BrowserCommand | null>;
  result(host: BrowserHostIdentity, requestId: string, value: unknown,
    signal: AbortSignal): Promise<void>;
  unregister(host: BrowserHostIdentity): Promise<void>;
  native(request: unknown): Promise<unknown>;
  owners(host: BrowserHostIdentity, signal: AbortSignal): Promise<BrowserOwnerChoice[]>;
  grant(host: BrowserHostIdentity, input: BrowserGrantInput, signal: AbortSignal): Promise<unknown>;
  revoke(host: BrowserHostIdentity, tabId: string, signal: AbortSignal): Promise<void>;
  changed(status: BrowserHostStatus): void;
}

interface Session {
  generation: number;
  controller: AbortController;
  host: BrowserHostIdentity | null;
  cache: BrowserCommandCache;
  deliveries: Set<Promise<void>>;
  heartbeat: Promise<void> | null;
}

/**
 * Native exception превращается в один cached result, чтобы ACK дошёл и при отказе.
 * Ошибка ACK не удаляет cache и никогда не повторяет уже отправленное действие сайта.
 */
export async function executeBrowserCommand(port: {
  now(): number;
  allowed(): boolean;
  execute(command: Record<string, unknown>): Promise<unknown>;
  reply(id: string, result: unknown): Promise<void>;
}, cache: BrowserCommandCache, command: BrowserCommand): Promise<void> {
  const key = `${command.hostId}/${command.hostEpoch}/${command.requestId}`;
  const { remainingMs: _remainingForFingerprint, ...identity } = command;
  const fingerprint = JSON.stringify(identity);
  let item = cache.get(key);

  if (item && item.fingerprint !== fingerprint) {
    throw new Error('browser_command_mismatch');
  }

  if (!item) {
    for (const [id, entry] of cache) {
      if (entry.settled && entry.expires <= port.now()) {
        cache.delete(id);
      }
    }

    if (cache.size >= 128 || !Number.isFinite(command.remainingMs)
      || command.remainingMs <= 0 || command.remainingMs > 15000) {
      throw new Error('browser_command_invalid');
    }

    const deadline = port.now() + command.remainingMs;
    const result = Promise.resolve().then(async () => {
      if (!port.allowed() || deadline <= port.now()) {
        return { ok: false, error: 'access_revoked' };
      }

      try {
        const { remainingMs: _remaining, ...payload } = command;

        return await port.execute({ ...payload, deadline });
      } catch (error) {
        const code = String((error as Error).message).match(
          new RegExp('(?:^|: )(browser_unavailable|access_revoked|stale_page|stale_element|'
            + 'element_obscured|browser_debugger_unavailable)$', 'u'),
        )?.[1];

        return { ok: false, error: code ?? 'browser_execution_failed' };
      }
    });

    item = {
      fingerprint,
      result,
      expires: deadline + 15000,
      settled: false
    };
    cache.set(key, item);

    const captured = item;

    void result.then(() => {
      captured.settled = true;
    });
  }

  await port.reply(command.requestId, await item.result);
}

/**
 * Транспорт живёт на корне main SPA и не зависит от маршрута BrowserView.
 * Смена scope синхронно отзывает generation и abort; поздний register не получает native доступ.
 */
export function createBrowserHost(port: HostPort) {
  let desired: string | null = null;
  let generation = 0;
  let current: Session | null = null;
  let closed = false;

  const active = (session: Session) => !closed && current === session
    && generation === session.generation && !session.controller.signal.aborted;

  /**
   * Остановка захватывает прежний host ID и не снимает новый lease другой сессии.
   * Недоступный сервер доживёт до lease timeout, native доступ снимается первым.
   */
  async function cleanup(session: Session): Promise<void> {
    session.controller.abort();

    if (session.host) {
      const host = session.host;

      await port.native({
        operation: 'host-stop',
        hostId: host.id,
        hostEpoch: host.hostEpoch,
      }).catch(() => undefined);
      await port.unregister(host).catch(() => undefined);
    }
  }

  /**
   * Одновременные UI sync и timer используют один heartbeat Promise.
   * Projection обновляет только существующие grants и не несёт owner из страницы.
   */
  function sync(session: Session): Promise<void> {
    if (!active(session) || !session.host) {
      return Promise.resolve();
    }

    if (session.heartbeat) {
      return session.heartbeat;
    }

    const host = session.host;
    const pending = (async () => {
      const snapshot = await port.native({ operation: 'state' }) as { grants?: unknown[] };

      if (!active(session)) {
        return;
      }

      const grants = snapshot.grants ?? [];
      const lease = await port.heartbeat(host, { grants }, session.controller.signal);

      if (!active(session)) {
        return;
      }

      if (!Number.isFinite(lease.leaseMs) || lease.leaseMs <= 0 || lease.leaseMs > 15000) {
        throw new Error('browser_lease_invalid');
      }

      await port.native({
        operation: 'host-start',
        hostId: host.id,
        hostEpoch: host.hostEpoch,
        leaseUntil: port.now() + lease.leaseMs,
      });
    })();

    session.heartbeat = pending;
    void pending.then(() => {
      if (session.heartbeat === pending) {
        session.heartbeat = null;
      }
    }, () => {
      if (session.heartbeat === pending) {
        session.heartbeat = null;
      }
    });

    return pending;
  }

  /**
   * Один long-poll выдаёт команды, а незавершённые разные tab выполняются параллельно.
   * Cache и native fence запрещают повтор effect даже при duplicate delivery.
   */
  async function poll(session: Session): Promise<void> {
    const host = session.host!;

    while (active(session)) {
      const command = await port.poll(host, session.controller.signal);

      if (!active(session)) {
        return;
      }

      if (!command) {
        continue;
      }

      if (command.hostId !== host.id || command.hostEpoch !== host.hostEpoch
        || typeof command.requestId !== 'string' || session.deliveries.size >= 32) {
        throw new Error('browser_command_invalid');
      }

      const delivery = executeBrowserCommand({
        now: port.now,
        allowed: () => active(session),
        execute: (value) => port.native({ operation: 'execute', command: value }),
        reply: async (id, value) => {
          if (active(session)) {
            await port.result(host, id, value, session.controller.signal);
          }
        },
      }, session.cache, command);

      session.deliveries.add(delivery);
      void delivery.then(() => session.deliveries.delete(delivery), () => {
        session.deliveries.delete(delivery);

        if (active(session)) {
          port.changed({ phase: 'error', error: 'browser_ack_failed' });
        }
      });
    }
  }

  /**
   * Heartbeat идёт независимо от долгого poll/execute и сам не продлевается poll-ом.
   * Любой transport failure завершает поколение, без автоматического takeover.
   */
  async function heartbeats(session: Session): Promise<void> {
    while (active(session)) {
      await port.wait(5000, session.controller.signal);

      if (active(session)) {
        await sync(session);
      }
    }
  }

  /**
   * До register ACK native не получает host capability.
   * Поздний ответ старого scope лишь освобождает его host, не запускает loops.
   */
  async function start(session: Session, takeover: boolean): Promise<void> {
    try {
      const host = await port.register(takeover, session.controller.signal);

      session.host = host;

      if (!active(session)) {
        await cleanup(session);

        return;
      }

      if (!host.id || !host.token || !Number.isSafeInteger(host.hostEpoch)
        || host.hostEpoch < 1 || host.leaseMs <= 0 || host.leaseMs > 15000) {
        throw new Error('browser_host_invalid');
      }

      await port.native({
        operation: 'host-start',
        hostId: host.id,
        hostEpoch: host.hostEpoch,
        leaseUntil: port.now() + host.leaseMs,
      });

      if (!active(session)) {
        await cleanup(session);

        return;
      }

      port.changed({ phase: 'online', error: '' });
      await Promise.all([poll(session), heartbeats(session)]);
    } catch (error) {
      if (active(session)) {
        const conflict = (error as { status?: number }).status === 409;

        port.changed({
          phase: conflict ? 'conflict' : 'error',
          error: conflict ? 'browser_host_conflict' : 'browser_unavailable',
        });
        current = null;
        await cleanup(session);
      }
    }
  }

  /**
   * Null scope означает disable/logout/offline/profile switch и запрещает эффекты сразу.
   * Повтор того же eligibility scope не плодит timer, poll или регистрацию.
   */
  function update(scope: string | null, takeover = false): void {
    if (closed || scope === desired && !takeover && current !== null) {
      return;
    }

    desired = scope;
    generation += 1;

    const previous = current;

    current = null;

    if (previous) {
      previous.controller.abort();
      void cleanup(previous);
    }

    if (scope === null) {
      port.changed({ phase: 'off', error: '' });

      return;
    }

    const session: Session = {
      generation,
      controller: new AbortController(),
      host: null,
      cache: new Map(),
      deliveries: new Set(),
      heartbeat: null,
    };

    current = session;
    port.changed({ phase: 'starting', error: '' });
    void start(session, takeover);
  }

  const required = () => {
    if (!current || !active(current) || !current.host) {
      throw new Error('browser_unavailable');
    }

    return current as Session & { host: BrowserHostIdentity };
  };

  return {
    update,
    retry(takeover = false) {
      if (desired !== null) {
        const scope = desired;

        desired = null;
        update(scope, takeover);
      }
    },
    sync: () => current ? sync(current) : Promise.resolve(),
    owners: async () => {
      const session = required();
      const choices = await port.owners(session.host, session.controller.signal);

      if (!active(session)) {
        throw new Error('browser_unavailable');
      }

      return choices;
    },
    grant: async (input: BrowserGrantInput) => {
      const session = required();
      const value = await port.grant(session.host, input, session.controller.signal);

      if (!active(session)) {
        throw new Error('browser_unavailable');
      }

      return value;
    },
    revoke: (tabId: string) => {
      const session = required();

      return port.revoke(session.host, tabId, session.controller.signal);
    },
    dispose() {
      update(null);
      closed = true;
    },
  };
}
