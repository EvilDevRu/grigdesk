import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

function sendTo(target, data) {
  if (typeof target?.send === 'function') {
    target.send(data);
  } else if (typeof target?.write === 'function') {
    target.write(data);
  }
}

function publicSession(session) {
  return {
    id: session.id,
    connectionId: session.connection.id,
    projectId: session.connection.projectId,
    label: session.connection.label,
    role: session.connection.role,
    host: session.connection.host,
    port: session.connection.port,
    user: session.connection.user,
    agentAllowed: session.agentAllowed,
    generation: session.generation,
    openedAt: session.openedAt,
  };
}

/**
 * Менеджер владеет SSH-клиентами независимо от браузерных окон. Attach влияет
 * только на fan-out терминала; завершает соединение исключительно явный close.
 */
export function createSshSessionManager(options = {}) {
  const transportFactory = options.transport || options;
  const replayBytes = Math.max(1_024, Number(options.replayBytes) || 256 * 1_024);
  const sessions = new Map();
  const events = new EventEmitter();

  function emit(type, session, extra = {}) {
    events.emit('change', { type, session: publicSession(session), ...extra });
  }

  function appendReplay(session, chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    session.replay = Buffer.concat([session.replay, data]);
    if (session.replay.length > replayBytes) {
      session.replay = session.replay.subarray(session.replay.length - replayBytes);
    }
    for (const target of session.attached) {
      sendTo(target, data);
    }
  }

  function settleRun(run, result) {
    if (run.settled) {
      return;
    }
    run.settled = true;
    run.session.runs.delete(run);
    run.resolve(result);
  }

  function cancelRuns(session, error) {
    for (const run of [...session.runs]) {
      settleRun(run, { ok: false, error });
      run.channel?.close?.();
      run.channel?.end?.();
    }
  }

  function lost(session, reason = 'session_lost') {
    if (!sessions.has(session.id)) {
      return;
    }
    sessions.delete(session.id);
    session.alive = false;
    session.generation += 1;
    cancelRuns(session, reason);
    for (const target of session.attached) {
      target.close?.();
    }
    session.attached.clear();
    emit('lost', session, { reason });
  }

  async function open({ connection, password, hostVerifier }) {
    const secret = Buffer.isBuffer(password) ? password : Buffer.from(String(password || ''));
    let transport;
    try {
      transport = await transportFactory.connect({ ...connection, password: secret, hostVerifier });
    } finally {
      secret.fill(0);
    }
    const shell = await transport.shell({ term: 'xterm-256color' });
    const session = {
      id: randomUUID(),
      connection: structuredClone(connection),
      transport,
      shell,
      replay: Buffer.alloc(0),
      attached: new Set(),
      runs: new Set(),
      alive: true,
      agentAllowed: false,
      generation: 1,
      openedAt: new Date().toISOString(),
    };
    sessions.set(session.id, session);
    shell.on?.('data', (chunk) => appendReplay(session, chunk));
    shell.on?.('close', () => lost(session));
    transport.on?.('close', () => lost(session));
    transport.on?.('error', () => lost(session));
    emit('opened', session);
    return publicSession(session);
  }

  function attach(idValue, target) {
    const session = sessions.get(String(idValue || ''));
    if (!session) {
      const error = new Error('SSH-сессия не найдена');
      error.code = 'session_not_found';
      throw error;
    }
    session.attached.add(target);
    if (session.replay.length) {
      sendTo(target, session.replay);
    }
    return () => {
      session.attached.delete(target);
    };
  }

  function write(idValue, data) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      return false;
    }
    session.shell.write(data);
    return true;
  }

  function resize(idValue, cols, rows) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      return false;
    }
    session.shell.setWindow?.(Number(rows) || 24, Number(cols) || 80, 0, 0);
    return true;
  }

  async function setAgentAccess(idValue, allowed) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      return { ok: false, error: 'session_lost' };
    }
    session.agentAllowed = allowed === true;
    session.generation += 1;
    if (!session.agentAllowed) {
      cancelRuns(session, 'access_revoked');
    }
    emit('access', session);
    return publicSession(session);
  }

  async function exec(idValue, command) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      return { ok: false, error: 'session_lost' };
    }
    if (!session.agentAllowed) {
      return { ok: false, error: 'not_allowed' };
    }
    const generation = session.generation;
    let channel;
    try {
      channel = await session.transport.exec(String(command));
    } catch {
      return session.alive
        ? { ok: false, error: 'command_failed' }
        : { ok: false, error: 'session_lost' };
    }
    if (!session.alive || !session.agentAllowed || generation !== session.generation) {
      channel.close?.();
      return { ok: false, error: session.alive ? 'access_revoked' : 'session_lost' };
    }
    return new Promise((resolve) => {
      const chunks = [];
      const run = { session, channel, resolve, settled: false };
      session.runs.add(run);
      channel.on?.('data', (chunk) => chunks.push(Buffer.from(chunk)));
      channel.stderr?.on?.('data', (chunk) => chunks.push(Buffer.from(chunk)));
      channel.once?.('error', () => {
        settleRun(run, session.alive
          ? { ok: false, error: 'command_failed' }
          : { ok: false, error: 'session_lost' });
      });
      channel.once?.('close', (code, signal) => {
        if (run.settled) {
          return;
        }
        const output = Buffer.concat(chunks).toString('utf8');
        if (!session.alive) {
          settleRun(run, { ok: false, error: 'session_lost' });
        } else if (Number(code) !== 0) {
          settleRun(run, {
            ok: false,
            error: 'command_failed',
            exitCode: Number(code),
            ...(signal ? { signal: String(signal) } : {}),
            ...(output ? { output } : {}),
          });
        } else {
          settleRun(run, { ok: true, output, exitCode: 0 });
        }
      });
    });
  }

  async function close(idValue) {
    const session = sessions.get(String(idValue || ''));
    if (!session) {
      return false;
    }
    lost(session);
    session.shell.close?.();
    session.shell.end?.();
    session.transport.close?.();
    return true;
  }

  async function closeAll(reason = 'session_lost') {
    await Promise.all([...sessions.keys()].map(async (id) => {
      const session = sessions.get(id);
      if (session) {
        lost(session, reason);
        session.transport.close?.();
      }
    }));
  }

  function listForAgent(projectId) {
    return [...sessions.values()]
      .filter((session) => session.alive
        && session.agentAllowed
        && session.connection.projectId === projectId)
      .map(publicSession);
  }

  function findForAgent(projectId, label, role) {
    return listForAgent(projectId).find((session) => (
      session.label === label && session.role === role
    )) || null;
  }

  async function openSftp(idValue) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      const error = new Error('SSH-сессия потеряна');
      error.code = 'session_not_found';
      throw error;
    }
    return session.transport.sftp();
  }

  async function listFiles(idValue, remotePath = '.') {
    const sftp = await openSftp(idValue);
    try {
      const entries = await new Promise((resolve, reject) => {
        sftp.readdir(String(remotePath || '.'), (error, value) => (
          error ? reject(error) : resolve(value)
        ));
      });
      return entries.map((entry) => ({
        name: entry.filename,
        type: entry.attrs?.isDirectory?.() ? 'directory' : 'file',
        size: Number(entry.attrs?.size) || 0,
        mtime: Number(entry.attrs?.mtime) || 0,
      }));
    } finally {
      sftp.end?.();
    }
  }

  async function downloadFile(idValue, remotePath) {
    const sftp = await openSftp(idValue);
    const stream = sftp.createReadStream(String(remotePath || ''));
    stream.once('close', () => sftp.end?.());
    stream.once('error', () => sftp.end?.());
    return stream;
  }

  async function uploadFile(idValue, remotePath, stream) {
    const sftp = await openSftp(idValue);
    const target = sftp.createWriteStream(String(remotePath || ''));
    await new Promise((resolve, reject) => {
      stream.once('error', reject);
      target.once('error', reject);
      target.once('close', resolve);
      stream.pipe(target);
    });
    sftp.end?.();
    return { ok: true };
  }

  return {
    open,
    attach,
    write,
    resize,
    exec,
    close,
    closeAll,
    setAgentAccess,
    list: () => [...sessions.values()].map(publicSession),
    get: (id) => sessions.has(String(id)) ? publicSession(sessions.get(String(id))) : null,
    listForAgent,
    findForAgent,
    listFiles,
    downloadFile,
    uploadFile,
    subscribe(listener) {
      events.on('change', listener);
      return () => events.off('change', listener);
    },
  };
}

export default createSshSessionManager;
