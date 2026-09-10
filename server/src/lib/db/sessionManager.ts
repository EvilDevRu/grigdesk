import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { DbProfile } from './store.ts';

type Payload = Record<string, unknown>;

type AnyFunction = (...args: never[]) => unknown;

// Сессия глазами всех, кто вне менеджера: ни драйвера, ни канала, ни пароля.
// `generation` растёт на каждой смене доступа агента и на потере соединения.
export interface PublicDbSession {
  id: string;
  profileId: string;
  projectId: string;
  label: string;
  role: string;
  engine: string;
  prod: boolean;
  via: string;
  agentAllowed: boolean;
  generation: number;
  readOnlyActive: boolean;
  openedAt: string;
}

export interface DbFailure {
  ok: false;
  error: string;
}

// Канал туннеля: менеджеру нужно только уметь его закрыть.
interface Channel {
  close?: () => unknown;
  end?: () => unknown;
  destroy?: () => unknown;
}

interface LiveRun {
  id?: string;
  queryId?: string;
  resolve?: (result: DbFailure) => void;
}

interface LiveSession {
  id: string;
  profile: DbProfile;
  engine: Payload;
  handle: Payload | null;
  channel: Channel | null;
  channels: Channel[];
  sshSessionId: string;
  sshGeneration: unknown;
  agentAllowed: boolean;
  generation: number;
  readOnlyActive: boolean;
  openedAt: string;
  runs: Set<LiveRun>;
  alive: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface DbSessionManagerOptions {
  engines?: Payload;
  sshSessions?: Payload;
  permissionQueue?: Payload;
  idleMs?: number | (() => number);
}

function publicSession(session: LiveSession): PublicDbSession {
  return {
    id: session.id,
    profileId: session.profile.id,
    projectId: session.profile.projectId,
    label: session.profile.label,
    role: session.profile.role,
    engine: session.profile.engine,
    prod: session.profile.prod === true,
    via: session.profile.via,
    agentAllowed: session.agentAllowed,
    generation: session.generation,
    readOnlyActive: session.readOnlyActive,
    openedAt: session.openedAt,
  };
}

// Отказ менеджера с машинным кодом: HTTP-слой переводит его в статус ответа.
class DbSessionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DbSessionError';
    this.code = code;
  }
}

function closeChannel(channel: Channel | null | undefined): void {
  channel?.close?.();
  channel?.end?.();
  channel?.destroy?.();
}

/** Менеджер владеет driver handles, SSH-каналами, допусками и активными запросами. */
export function createDbSessionManager(options: DbSessionManagerOptions = {}) {
  const engines = options.engines;
  const sshSessions = options.sshSessions;
  const permissionQueue = options.permissionQueue;
  const idleMs = options.idleMs;
  const sessions = new Map<string, LiveSession>();
  const events = new EventEmitter();

  // Снятие висящих подтверждений этой сессии: спрашивать про доступ, которого уже
  // нет, нельзя — человек ответил бы на вопрос о мёртвом соединении.
  function cancelPending(sessionId: string, reason: string): void {
    const cancelWhere = permissionQueue?.cancelWhere as
      ((match: (entry: Payload) => boolean, outcome: Payload) => unknown) | undefined;

    cancelWhere?.call(
      permissionQueue,
      (entry: Payload) => entry.origin === 'db' && entry.sessionId === sessionId,
      { allow: false, error: reason },
    );
  }

  function emit(type: string, session: LiveSession, extra: Payload = {}): void {
    events.emit('change', { type, session: publicSession(session), ...extra });
  }

  function resetIdle(session: LiveSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);

    const delay = Math.max(0, Number(typeof idleMs === 'function' ? idleMs() : idleMs) || 0);

    if (!delay) return;
    session.idleTimer = setTimeout(() => void close(session.id, 'idle_timeout'), delay);
    session.idleTimer.unref?.();
  }

  async function open({ profile, password, sshSessionId = '' }: {
    profile?: DbProfile;
    password?: unknown;
    sshSessionId?: string;
  } = {}): Promise<PublicDbSession> {
    const target = profile as DbProfile;
    const lookupEngine = engines?.get as AnyFunction | undefined;
    const engine = lookupEngine?.call(engines, target?.engine as never) as Payload;
    if (!engine) throw new DbSessionError('engine_not_found', 'Движок БД не найден');
    const secret = Buffer.isBuffer(password) ? password : Buffer.from(String(password || ''));
    const channels: Channel[] = [];
    let channel: Channel | null = null;
    let handle: Payload | null = null;
    let sshGeneration: unknown = null;
    let openStream: (() => Promise<Channel>) | null = null;
    try {
      if (target.via === 'ssh') {
        const lookup = sshSessions?.get as AnyFunction | undefined;
        const ssh = lookup?.call(sshSessions, sshSessionId as never) as Payload | null;

        if (!ssh || ssh.projectId !== target.projectId || ssh.alive === false) {
          throw new DbSessionError(
            'ssh_session_not_found',
            'SSH-сессия для профиля БД недоступна',
          );
        }
        sshGeneration = ssh.generation;

        const forward = (sshSessions?.forwardOut || sshSessions?.openForward) as
          ((id: string, request: Payload) => Promise<Channel>) | undefined;

        if (typeof forward !== 'function') {
          throw new DbSessionError(
            'ssh_forward_unavailable',
            'SSH transport не поддерживает direct-tcpip',
          );
        }
        // Отмена запроса и таймаут требуют СВОЕГО канала: рабочий занят самим запросом,
        // а второй сокет мимо туннеля ушёл бы напрямую и обошёл рубеж.
        openStream = async () => {
          const next = await forward.call(sshSessions, sshSessionId, {
            projectId: target.projectId,
            generation: ssh.generation,
            host: target.host,
            port: target.port,
          });

          channels.push(next);

          return next;
        };
        channel = await openStream();
      }
      handle = await (engine.open as (input: Payload) => Promise<Payload>)({
        profile: structuredClone(target),
        password: secret,
        stream: channel,
        openStream,
      });
    } catch (error) {
      channels.forEach(closeChannel);
      throw error;
    } finally {
      secret.fill(0);
    }
    const session: LiveSession = {
      id: randomUUID(),
      profile: structuredClone(target),
      engine,
      handle,
      channel,
      channels,
      sshSessionId: target.via === 'ssh' ? String(sshSessionId) : '',
      sshGeneration,
      agentAllowed: false,
      generation: 1,
      readOnlyActive: handle?.readOnlyActive === true,
      openedAt: new Date().toISOString(),
      runs: new Set(),
      alive: true,
      idleTimer: null,
    };
    sessions.set(session.id, session);
    resetIdle(session);
    emit('opened', session);
    return publicSession(session);
  }

  async function cancelRuns(session: LiveSession, reason: string): Promise<void> {
    for (const run of [...session.runs]) {
      const cancel = session.engine.cancel as
        ((handle: Payload | null, run: LiveRun) => unknown) | undefined;

      await Promise.resolve(cancel?.call(session.engine, session.handle, run)).catch(() => {});
      run.resolve?.({ ok: false, error: reason });
      session.runs.delete(run);
    }
  }

  async function close(idValue: string, reason = 'session_lost'): Promise<boolean> {
    const session = sessions.get(String(idValue || ''));
    if (!session) return false;
    sessions.delete(session.id);
    session.alive = false;
    session.generation += 1;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    await cancelRuns(session, reason);
    cancelPending(session.id, reason);
    try {
      const handleClose = session.handle?.close as (() => Promise<unknown>) | undefined;
      const engineClose = session.engine.close as
        ((handle: Payload | null) => unknown) | undefined;

      if (typeof handleClose === 'function') await handleClose.call(session.handle);
      else await engineClose?.call(session.engine, session.handle);
    } finally {
      (session.channels?.length ? session.channels : [session.channel]).forEach(closeChannel);
    }
    emit('lost', session, { reason });
    return true;
  }

  async function closeAll(reason = 'session_lost'): Promise<void> {
    await Promise.all([...sessions.keys()].map((id) => close(id, reason)));
  }

  async function setAgentAccess(
    idValue: string,
    allowed: boolean,
  ): Promise<PublicDbSession | DbFailure> {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) return { ok: false, error: 'session_lost' };
    session.agentAllowed = allowed === true;
    session.generation += 1;
    if (!session.agentAllowed) {
      await cancelRuns(session, 'access_revoked');
      cancelPending(session.id, 'access_revoked');
    }
    resetIdle(session);
    emit('access', session);
    return publicSession(session);
  }

  function trackRun(idValue: string, run: LiveRun): (() => void) | false {
    const session = sessions.get(String(idValue || ''));

    if (!session?.alive) return false;
    session.runs.add(run);
    resetIdle(session);
    return () => session.runs.delete(run);
  }

  function internal(idValue: string): LiveSession | null {
    return sessions.get(String(idValue || '')) || null;
  }

  function listForAgent(projectId: string): PublicDbSession[] {
    return [...sessions.values()].filter((session) => (
      session.alive && session.agentAllowed && session.profile.projectId === projectId
    )).map(publicSession);
  }

  function findForAgent(projectId: string, label: string, role: string) {
    const session = [...sessions.values()].find((item) => (
      item.alive && item.agentAllowed && item.profile.projectId === projectId
      && item.profile.label === label && item.profile.role === role
    ));
    return session ? { ...publicSession(session), handle: session.handle } : null;
  }

  // Упавший туннель уносит с собой все базы, что шли через него: соединение к ним
  // мертво, а живая вкладка обещала бы работающий доступ.
  const sshLost = (event: Payload) => {
    const type = (event?.type as string) || 'lost';
    const sshId = (event?.session as Payload | undefined)?.id || event?.id;

    if (type !== 'lost' || !sshId) return;

    for (const session of [...sessions.values()]) {
      if (session.sshSessionId === sshId) {
        void close(session.id, (event?.reason as string) || 'session_lost');
      }
    }
  };

  const listen = sshSessions?.on as AnyFunction | undefined;

  listen?.call(sshSessions, 'lost' as never, sshLost as never);
  const subscribe = sshSessions?.subscribe as
    ((listener: (event: Payload) => void) => (() => void)) | undefined;
  const unsubscribe = subscribe?.call(sshSessions, sshLost);

  return {
    open,
    close,
    closeAll,
    async dispose(reason = 'server_shutdown') {
      await closeAll(reason);
      unsubscribe?.();
      (sshSessions?.off as AnyFunction | undefined)?.call(
        sshSessions,
        'lost' as never,
        sshLost as never,
      );
    },
    setAgentAccess,
    trackRun,
    list: () => [...sessions.values()].map(publicSession),
    get: (id: string) => {
      const session = internal(id);

      return session ? publicSession(session) : null;
    },
    find: (id: string) => internal(id),
    current: (id: string) => internal(id),
    listForAgent,
    findForAgent,
    subscribe(listener: (event: Payload) => void) {
      events.on('change', listener);
      return () => events.off('change', listener);
    },
  };
}

export default createDbSessionManager;
