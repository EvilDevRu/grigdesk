import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { createExecEcho } from './echo.ts';
import type { ExecEcho } from './echo.ts';
import { SshFailure } from './failure.ts';
import type { SshTransport, SshTransportSession } from './transport.ts';
import type { Readable } from 'node:stream';

// Описание соединения, как его хранит панель. Пароль сюда не попадает никогда: он
// приходит отдельным аргументом open и стирается сразу после установки соединения.
export interface SshConnectionRef {
  id: string;
  projectId: string;
  label: string;
  role: string;
  host: string;
  port: number;
  user: string;
}

// Сессия глазами всех, кто вне менеджера: ни клиента, ни канала, ни буфера повтора.
export interface PublicSshSession {
  id: string;
  connectionId: string;
  projectId: string;
  label: string;
  role: string;
  host: string;
  port: number;
  user: string;
  agentAllowed: boolean;
  generation: number;
  openedAt: string;
}

export interface ExecOutcome {
  ok: boolean;
  error?: string;
  output?: string;
  exitCode?: number;
  signal?: string;
}

// Запись каталога, как её отдаёт SFTP. Объявлена здесь, а не взята у библиотеки:
// менеджеру нужны только имя и атрибуты, и знать о ssh2 ему незачем.
interface SftpEntry {
  filename: string;
  attrs?: {
    size?: number;
    mtime?: number;
    isDirectory?: () => boolean;
  };
}

export interface SshFileEntry {
  name: string;
  type: 'directory' | 'file';
  size: number;
  mtime: number;
}

// Окно терминала: браузерный WebSocket отдаёт send, а тест — write. Менеджер знает
// только это, поэтому fan-out одинаково работает и в бою, и в проверке.
export interface TerminalTarget {
  send?: (data: Buffer | string) => void;
  write?: (data: Buffer | string) => void;
  close?: () => void;
}

export interface SessionChangeEvent {
  type: 'opened' | 'lost' | 'access';
  session: PublicSshSession;
  reason?: string;
}

export interface SshSessionManagerOptions {
  transport?: SshTransport;
  replayBytes?: number;
  echoEnabled?: () => boolean;
  echoLimitBytes?: number;
}

export interface OpenSessionRequest {
  connection: SshConnectionRef;
  password: Buffer | string;
  hostVerifier?: (fingerprint: string) => boolean;
}

export interface ForwardRequest {
  projectId?: string;
  generation?: number;
  host?: string;
  port?: number;
}

// Подписка на канал: данные, закрытие и обрыв. Больше менеджеру ничего не нужно, а
// три сигнатуры вместо общей «строка и функция» не дают перепутать закрытие с данными.
interface ChannelSubscribe {
  (event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  (event: 'close', listener: (code?: number | null, signal?: string | null) => void): unknown;
  (event: 'error', listener: (error?: unknown) => void): unknown;
}

// Каналы описаны ровно тем, чем менеджер пользуется. Часть методов необязательна:
// в бою их даёт ssh2, а в тестах канал подменяют упрощённой заглушкой.
export interface SshChannel {
  on?: ChannelSubscribe;
  once?: ChannelSubscribe;
  stderr?: { on?: ChannelSubscribe };
  write: (data: unknown) => unknown;
  setWindow?: (rows: number, cols: number, height: number, width: number) => unknown;
  close?: () => unknown;
  end?: () => unknown;
  destroy?: () => unknown;
}

export interface SshSessionManager {
  open: (request: OpenSessionRequest) => Promise<PublicSshSession>;
  attach: (id: string, target: TerminalTarget) => () => void;
  write: (id: string, data: unknown) => boolean;
  resize: (id: string, cols: number, rows: number) => boolean;
  exec: (id: string, command: string) => Promise<ExecOutcome>;
  forwardOut: (id: string, options?: ForwardRequest) => Promise<SshChannel>;
  openForward: (id: string, options?: ForwardRequest) => Promise<SshChannel>;
  close: (id: string) => Promise<boolean>;
  closeAll: (reason?: string) => Promise<void>;
  setAgentAccess: (id: string, allowed: boolean) => Promise<PublicSshSession | ExecOutcome>;
  list: () => PublicSshSession[];
  get: (id: string) => PublicSshSession | null;
  listForAgent: (projectId: string) => PublicSshSession[];
  findForAgent: (projectId: string, label: string, role: string) => PublicSshSession | null;
  listFiles: (id: string, remotePath?: string) => Promise<SshFileEntry[]>;
  downloadFile: (id: string, remotePath: string) => Promise<Readable>;
  uploadFile: (
    id: string,
    remotePath: string,
    stream: NodeJS.ReadableStream,
  ) => Promise<{ ok: true }>;
  subscribe: (listener: (event: SessionChangeEvent) => void) => () => void;
}

interface LiveRun {
  session: LiveSession;
  channel: SshChannel | null;
  resolve: (result: ExecOutcome) => void;
  settled: boolean;
  echo: ExecEcho | null;
}

interface LiveSession {
  id: string;
  connection: SshConnectionRef;
  transport: SshTransportSession;
  shell: SshChannel;
  replay: Buffer;
  attached: Set<TerminalTarget>;
  forwardChannels: Set<SshChannel>;
  runs: Set<LiveRun>;
  alive: boolean;
  agentAllowed: boolean;
  generation: number;
  openedAt: string;
}

function sendTo(target: TerminalTarget, data: Buffer | string): void {
  if (typeof target?.send === 'function') {
    target.send(data);
  } else if (typeof target?.write === 'function') {
    target.write(data);
  }
}

function publicSession(session: LiveSession): PublicSshSession {
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
export function createSshSessionManager(
  options: SshSessionManagerOptions = {},
): SshSessionManager {
  const transportFactory = (options.transport || options) as SshTransport;
  const replayBytes = Math.max(1_024, Number(options.replayBytes) || 256 * 1_024);
  const echoEnabled = options.echoEnabled || (() => true);
  const echoLimitBytes = Math.max(0, Number(options.echoLimitBytes) || 64 * 1_024);
  const sessions = new Map<string, LiveSession>();
  const events = new EventEmitter();

  function emit(
    type: SessionChangeEvent['type'],
    session: LiveSession,
    extra: { reason?: string } = {},
  ): void {
    events.emit('change', { type, session: publicSession(session), ...extra });
  }

  function appendReplay(session: LiveSession, chunk: Buffer | string): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    session.replay = Buffer.concat([session.replay, data]);
    if (session.replay.length > replayBytes) {
      session.replay = session.replay.subarray(session.replay.length - replayBytes);
    }
    for (const target of session.attached) {
      sendTo(target, data);
    }
  }

  /**
   * Эхо агентской команды идёт ВНИЗ, в fan-out окон терминала, и не касается shell-канала:
   * человек видит происходящее, но текст не может стать вводом его оболочки. Мёртвую
   * сессию не трогаем — её окна уже закрыты.
   */
  function echoToTerminal(session: LiveSession, text: string): void {
    if (!text || !session.alive) {
      return;
    }
    appendReplay(session, text);
  }

  function settleRun(run: LiveRun, result: ExecOutcome): void {
    if (run.settled) {
      return;
    }
    run.settled = true;
    run.session.runs.delete(run);
    if (run.echo) {
      echoToTerminal(run.session, run.echo.finish(result));
    }
    run.resolve(result);
  }

  function cancelRuns(session: LiveSession, error: string): void {
    for (const run of [...session.runs]) {
      settleRun(run, { ok: false, error });
      run.channel?.close?.();
      run.channel?.end?.();
    }
  }

  function lost(session: LiveSession, reason = 'session_lost'): void {
    if (!sessions.has(session.id)) {
      return;
    }
    sessions.delete(session.id);
    session.alive = false;
    session.generation += 1;
    cancelRuns(session, reason);
    for (const channel of session.forwardChannels) {
      channel.close?.();
      channel.end?.();
      channel.destroy?.();
    }
    session.forwardChannels.clear();
    for (const target of session.attached) {
      target.close?.();
    }
    session.attached.clear();
    emit('lost', session, { reason });
  }

  async function open(
    { connection, password, hostVerifier }: OpenSessionRequest,
  ): Promise<PublicSshSession> {
    const secret = Buffer.isBuffer(password) ? password : Buffer.from(String(password || ''));
    let transport: SshTransportSession;
    try {
      transport = await transportFactory.connect({ ...connection, password: secret, hostVerifier });
    } finally {
      secret.fill(0);
    }
    const shell = await transport.shell({ term: 'xterm-256color' });
    const session: LiveSession = {
      id: randomUUID(),
      connection: structuredClone(connection),
      transport,
      shell,
      replay: Buffer.alloc(0),
      attached: new Set<TerminalTarget>(),
      forwardChannels: new Set<SshChannel>(),
      runs: new Set<LiveRun>(),
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

  function attach(idValue: string, target: TerminalTarget): () => void {
    const session = sessions.get(String(idValue || ''));
    if (!session) {
      throw new SshFailure('session_not_found', 'SSH-сессия не найдена');
    }
    session.attached.add(target);
    if (session.replay.length) {
      sendTo(target, session.replay);
    }
    return () => {
      session.attached.delete(target);
    };
  }

  function write(idValue: string, data: unknown): boolean {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      return false;
    }
    session.shell.write(data);
    return true;
  }

  function resize(idValue: string, cols: number, rows: number): boolean {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      return false;
    }
    session.shell.setWindow?.(Number(rows) || 24, Number(cols) || 80, 0, 0);
    return true;
  }

  async function setAgentAccess(
    idValue: string,
    allowed: boolean,
  ): Promise<PublicSshSession | ExecOutcome> {
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

  async function exec(idValue: string, command: string): Promise<ExecOutcome> {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      return { ok: false, error: 'session_lost' };
    }
    if (!session.agentAllowed) {
      return { ok: false, error: 'not_allowed' };
    }
    const generation = session.generation;
    let channel: SshChannel;
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
    const echo = echoEnabled() ? createExecEcho({ limitBytes: echoLimitBytes }) : null;
    if (echo) {
      echoToTerminal(session, echo.start(String(command)));
    }

    return new Promise<ExecOutcome>((resolve) => {
      const chunks: Buffer[] = [];
      const run: LiveRun = { session, channel, resolve, settled: false, echo };
      session.runs.add(run);
      const collect = (chunk: Buffer | string) => {
        chunks.push(Buffer.from(chunk as Buffer));
        if (echo) {
          echoToTerminal(session, echo.data(chunk));
        }
      };
      channel.on?.('data', collect);
      channel.stderr?.on?.('data', collect);
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

  async function close(idValue: string): Promise<boolean> {
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

  /** Scoped direct-tcpip канал принадлежит SSH-сессии и не попадает в terminal replay. */
  async function forwardOut(idValue: string, options: ForwardRequest = {}): Promise<SshChannel> {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive
      || session.connection.projectId !== String(options.projectId || '')
      || session.generation !== Number(options.generation)) {
      throw new SshFailure('session_lost', 'SSH-сессия для туннеля недоступна');
    }
    const channel = await session.transport.forwardOut({
      host: String(options.host || ''),
      port: Number(options.port),
    });
    if (!session.alive || session.generation !== Number(options.generation)) {
      channel.close?.();
      channel.destroy?.();
      throw new SshFailure('session_lost', 'SSH-сессия потеряна при открытии туннеля');
    }
    session.forwardChannels.add(channel);
    const forget = () => {
      session.forwardChannels.delete(channel);
    };
    channel.once?.('close', forget);
    channel.once?.('error', forget);
    return channel;
  }

  async function closeAll(reason = 'session_lost'): Promise<void> {
    await Promise.all([...sessions.keys()].map(async (id) => {
      const session = sessions.get(id);
      if (session) {
        lost(session, reason);
        session.transport.close?.();
      }
    }));
  }

  function listForAgent(projectId: string): PublicSshSession[] {
    return [...sessions.values()]
      .filter((session) => session.alive
        && session.agentAllowed
        && session.connection.projectId === projectId)
      .map(publicSession);
  }

  function findForAgent(
    projectId: string,
    label: string,
    role: string,
  ): PublicSshSession | null {
    return listForAgent(projectId).find((session) => (
      session.label === label && session.role === role
    )) || null;
  }

  async function openSftp(idValue: string) {
    const session = sessions.get(String(idValue || ''));
    if (!session?.alive) {
      throw new SshFailure('session_not_found', 'SSH-сессия потеряна');
    }
    return session.transport.sftp();
  }

  async function listFiles(idValue: string, remotePath = '.'): Promise<SshFileEntry[]> {
    const sftp = await openSftp(idValue);
    try {
      const entries = await new Promise<SftpEntry[]>((resolve, reject) => {
        sftp.readdir(String(remotePath || '.'), (error, value) => (
          error ? reject(error) : resolve(value)
        ));
      });
      return entries.map((entry): SshFileEntry => ({
        name: entry.filename,
        type: entry.attrs?.isDirectory?.() ? 'directory' : 'file',
        size: Number(entry.attrs?.size) || 0,
        mtime: Number(entry.attrs?.mtime) || 0,
      }));
    } finally {
      sftp.end?.();
    }
  }

  async function downloadFile(idValue: string, remotePath: string) {
    const sftp = await openSftp(idValue);
    const stream = sftp.createReadStream(String(remotePath || ''));
    stream.once('close', () => sftp.end?.());
    stream.once('error', () => sftp.end?.());
    return stream;
  }

  async function uploadFile(
    idValue: string,
    remotePath: string,
    stream: NodeJS.ReadableStream,
  ): Promise<{ ok: true }> {
    const sftp = await openSftp(idValue);
    const target = sftp.createWriteStream(String(remotePath || ''));
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      target.once('error', reject);
      target.once('close', () => resolve());
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
    forwardOut,
    openForward: forwardOut,
    close,
    closeAll,
    setAgentAccess,
    list: () => [...sessions.values()].map(publicSession),
    get: (id: string) => {
      const session = sessions.get(String(id));

      return session ? publicSession(session) : null;
    },
    listForAgent,
    findForAgent,
    listFiles,
    downloadFile,
    uploadFile,
    subscribe(listener: (event: SessionChangeEvent) => void) {
      events.on('change', listener);
      return () => events.off('change', listener);
    },
  };
}

export default createSshSessionManager;
