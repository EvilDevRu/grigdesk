import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

function publicSession(session) {
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

function closeChannel(channel) {
  channel?.close?.();
  channel?.end?.();
  channel?.destroy?.();
}

/** Менеджер владеет driver handles, SSH-каналами, допусками и активными запросами. */
export function createDbSessionManager(options = {}) {
  const engines = options.engines;
  const sshSessions = options.sshSessions;
  const permissionQueue = options.permissionQueue;
  const idleMs = options.idleMs;
  const sessions = new Map();
  const events = new EventEmitter();

  function emit(type, session, extra = {}) {
    events.emit('change', { type, session: publicSession(session), ...extra });
  }

  function resetIdle(session) {
    clearTimeout(session.idleTimer);
    const delay = Math.max(0, Number(typeof idleMs === 'function' ? idleMs() : idleMs) || 0);
    if (!delay) return;
    session.idleTimer = setTimeout(() => close(session.id, 'idle_timeout'), delay);
    session.idleTimer.unref?.();
  }

  async function open({ profile, password, sshSessionId = '' } = {}) {
    const engine = engines?.get?.(profile?.engine);
    if (!engine) {
      const error = new Error('Движок БД не найден');
      error.code = 'engine_not_found';
      throw error;
    }
    const secret = Buffer.isBuffer(password) ? password : Buffer.from(String(password || ''));
    const channels = [];
    let channel = null;
    let handle = null;
    let sshGeneration = null;
    let openStream = null;
    try {
      if (profile.via === 'ssh') {
        const ssh = sshSessions?.get?.(sshSessionId);
        if (!ssh || ssh.projectId !== profile.projectId || ssh.alive === false) {
          const error = new Error('SSH-сессия для профиля БД недоступна');
          error.code = 'ssh_session_not_found';
          throw error;
        }
        sshGeneration = ssh.generation;
        const forward = sshSessions.forwardOut || sshSessions.openForward;
        if (typeof forward !== 'function') {
          const error = new Error('SSH transport не поддерживает direct-tcpip');
          error.code = 'ssh_forward_unavailable';
          throw error;
        }
        // Отмена запроса и таймаут требуют СВОЕГО канала: рабочий занят самим запросом,
        // а второй сокет мимо туннеля ушёл бы напрямую и обошёл рубеж.
        openStream = async () => {
          const next = await forward.call(sshSessions, sshSessionId, {
            projectId: profile.projectId,
            generation: ssh.generation,
            host: profile.host,
            port: profile.port,
          });
          channels.push(next);
          return next;
        };
        channel = await openStream();
      }
      handle = await engine.open({
        profile: structuredClone(profile),
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
    const session = {
      id: randomUUID(),
      profile: structuredClone(profile),
      engine,
      handle,
      channel,
      channels,
      sshSessionId: profile.via === 'ssh' ? String(sshSessionId) : '',
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

  async function cancelRuns(session, reason) {
    for (const run of [...session.runs]) {
      await Promise.resolve(session.engine.cancel?.(session.handle, run)).catch(() => {});
      run.resolve?.({ ok: false, error: reason });
      session.runs.delete(run);
    }
  }

  async function close(idValue, reason = 'session_lost') {
    const session = sessions.get(String(idValue || ''));
    if (!session) return false;
    sessions.delete(session.id);
    session.alive = false;
    session.generation += 1;
    clearTimeout(session.idleTimer);
    await cancelRuns(session, reason);
    permissionQueue?.cancelWhere?.(
      (entry) => entry.origin === 'db' && entry.sessionId === session.id,
      { allow: false, error: reason },
    );
    try {
      if (typeof session.handle?.close === 'function') await session.handle.close();
      else await session.engine.close?.(session.handle);
    } finally {
      (session.channels?.length ? session.channels : [session.channel]).forEach(closeChannel);
    }
    emit('lost', session, { reason });
    return true;
  }

  async function closeAll(reason = 'session_lost') {
    await Promise.all([...sessions.keys()].map((id) => close(id, reason)));
  }

  async function setAgentAccess(idValue, allowed) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) return { ok: false, error: 'session_lost' };
    session.agentAllowed = allowed === true;
    session.generation += 1;
    if (!session.agentAllowed) {
      await cancelRuns(session, 'access_revoked');
      permissionQueue?.cancelWhere?.(
        (entry) => entry.origin === 'db' && entry.sessionId === session.id,
        { allow: false, error: 'access_revoked' },
      );
    }
    resetIdle(session);
    emit('access', session);
    return publicSession(session);
  }

  function trackRun(idValue, run) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) return false;
    session.runs.add(run);
    resetIdle(session);
    return () => session.runs.delete(run);
  }

  function internal(idValue) {
    return sessions.get(String(idValue || '')) || null;
  }

  function listForAgent(projectId) {
    return [...sessions.values()].filter((session) => (
      session.alive && session.agentAllowed && session.profile.projectId === projectId
    )).map(publicSession);
  }

  function findForAgent(projectId, label, role) {
    const session = [...sessions.values()].find((item) => (
      item.alive && item.agentAllowed && item.profile.projectId === projectId
      && item.profile.label === label && item.profile.role === role
    ));
    return session ? { ...publicSession(session), handle: session.handle } : null;
  }

  const sshLost = (event) => {
    const type = event?.type || 'lost';
    const sshId = event?.session?.id || event?.id;
    if (type !== 'lost' || !sshId) return;
    for (const session of [...sessions.values()]) {
      if (session.sshSessionId === sshId) close(session.id, event?.reason || 'session_lost');
    }
  };
  sshSessions?.on?.('lost', sshLost);
  const unsubscribe = sshSessions?.subscribe?.(sshLost);

  return {
    open,
    close,
    closeAll,
    async dispose(reason = 'server_shutdown') {
      await closeAll(reason);
      unsubscribe?.();
      sshSessions?.off?.('lost', sshLost);
    },
    setAgentAccess,
    trackRun,
    list: () => [...sessions.values()].map(publicSession),
    get: (id) => {
      const session = internal(id);
      return session ? publicSession(session) : null;
    },
    find: (id) => internal(id),
    current: (id) => internal(id),
    listForAgent,
    findForAgent,
    subscribe(listener) {
      events.on('change', listener);
      return () => events.off('change', listener);
    },
  };
}

export default createDbSessionManager;
