import { promises as fs } from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';

import {
  assertResolvedEgressAddresses,
  normalizeEgressHost,
} from './egressPolicy.ts';

export const KIMI_EGRESS_ALLOWLIST_VERSION = 'kimi-code-0.31.1-egress-v1';
export const KIMI_EGRESS_ALLOWED_HOSTS = Object.freeze(['api.kimi.com', 'auth.kimi.com']);

const MAX_HEADER_BYTES = 16 * 1024;
const HEADER_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 12_000;
// Linux sockaddr_un.sun_path — 108 байт вместе с завершающим NUL.
// Node на переполнении иногда возвращает вводящий в заблуждение EADDRINUSE.
export const MAX_UNIX_SOCKET_PATH_BYTES = 107;

// Адрес, к которому proxy открывает соединение: уже проверенный IP и его семейство.
interface EgressRecord {
  address: string;
  family: number;
}

export function assertUnixSocketPath(socketPath: string, label = 'unix_socket'): string {
  if (!path.isAbsolute(socketPath || '')) throw new TypeError(`${label} path должен быть абсолютным`);
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`${label}_path_too_long`);
  }
  return socketPath;
}

function httpError(socket: net.Socket, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function parseConnectTarget(header: unknown, {
  allowedHosts = KIMI_EGRESS_ALLOWED_HOSTS,
  allowedPorts = [443],
}: {
  allowedHosts?: readonly string[];
  allowedPorts?: readonly number[];
} = {}): { host: string; port: number } {
  const firstLine = String(header).split('\r\n', 1)[0] || '';
  const match = /^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(firstLine);
  if (!match) throw Object.assign(new Error('proxy_connect_required'), { status: 405 });
  const host = normalizeEgressHost(match[1]);
  const port = Number(match[2]);
  const hosts = new Set(allowedHosts.map(normalizeEgressHost));
  if (!hosts.has(host)) throw Object.assign(new Error('egress_host_not_allowlisted'), { status: 403 });
  if (!allowedPorts.includes(port)) throw Object.assign(new Error('egress_port_not_allowlisted'), { status: 403 });
  return { host, port };
}

async function resolvePublic(host: string, lookup = dns.lookup): Promise<EgressRecord[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  const addresses = records.map((entry) => (typeof entry === 'string' ? entry : entry.address));
  assertResolvedEgressAddresses(addresses);
  return records.map((entry) => (typeof entry === 'string'
    ? { address: entry, family: net.isIP(entry) }
    : entry));
}

function connectAddress(
  { address, family }: EgressRecord,
  port: number,
  connector: typeof net.createConnection = net.createConnection,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const upstream = connector({ host: address, port, family });
    const timer = setTimeout(() => upstream.destroy(new Error('egress_connect_timeout')), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    upstream.once('connect', () => {
      clearTimeout(timer);
      resolve(upstream);
    });
    upstream.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connectAny(
  records: EgressRecord[],
  port: number,
  connector?: typeof net.createConnection,
): Promise<net.Socket> {
  let lastError: unknown = null;
  for (const record of records) {
    try { return await connectAddress(record, port, connector); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error('egress_connect_failed');
}

/**
 * Минимальный HTTPS CONNECT proxy. DNS выполняется на host, адреса private/local
 * отсекаются до connect, а TCP открывается к уже проверенному IP — DNS rebinding
 * между проверкой и соединением невозможен.
 */
export function createKimiEgressProxy({
  socketPath,
  allowedHosts = KIMI_EGRESS_ALLOWED_HOSTS,
  allowedPorts = [443],
  lookup = dns.lookup,
  connector = net.createConnection,
}: {
  socketPath: string;
  allowedHosts?: readonly string[];
  allowedPorts?: readonly number[];
  lookup?: typeof dns.lookup;
  connector?: typeof net.createConnection;
}) {
  assertUnixSocketPath(socketPath, 'egress_socket');
  const active = new Set<net.Socket>();
  let server: net.Server | null = null;

  async function handle(client: net.Socket): Promise<void> {
    active.add(client);
    client.once('close', () => active.delete(client));
    client.setTimeout(HEADER_TIMEOUT_MS, () => client.destroy(new Error('proxy_header_timeout')));
    let buffered = Buffer.alloc(0);

    const onData = async (chunk: Buffer) => {
      client.pause();
      client.off('data', onData);
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HEADER_BYTES) {
        httpError(client, 431, 'Request Header Fields Too Large');
        return;
      }
      const boundary = buffered.indexOf('\r\n\r\n');
      if (boundary < 0) {
        client.on('data', onData);
        client.resume();
        return;
      }
      try {
        const target = parseConnectTarget(buffered.subarray(0, boundary).toString('latin1'), {
          allowedHosts, allowedPorts,
        });
        const records = await resolvePublic(target.host, lookup);
        const upstream = await connectAny(records, target.port, connector);
        active.add(upstream);
        upstream.once('close', () => active.delete(upstream));
        client.setTimeout(0);
        const remainder = buffered.subarray(boundary + 4);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream).pipe(client);
        client.resume();
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        httpError(client, status || 502, status === 403 ? 'Forbidden' : 'Bad Gateway');
      }
    };
    client.on('data', onData);
  }

  return {
    socketPath,
    allowlistVersion: KIMI_EGRESS_ALLOWLIST_VERSION,
    async start() {
      if (server) return this;
      await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      let existing = null;
      try { existing = await fs.lstat(socketPath); } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error;
      }
      if (existing && !existing.isSocket()) throw new Error('egress_proxy_path_not_socket');
      if (existing) await fs.unlink(socketPath);
      const listener = net.createServer((client) => {
        handle(client).catch(() => client.destroy());
      });
      server = listener;
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(socketPath, () => resolve());
      });
      listener.removeAllListeners('error');
      listener.on('error', () => {});
      await fs.chmod(socketPath, 0o600);
      return this;
    },
    async close() {
      if (!server) return;
      const current = server;
      server = null;
      for (const socket of active) socket.destroy();
      active.clear();
      await new Promise<void>((resolve) => { current.close(() => resolve()); });
      const info = await fs.lstat(socketPath).catch(() => null);
      if (info?.isSocket()) await fs.unlink(socketPath).catch(() => {});
    },
  };
}

// Общий proxy и счётчик его пользователей: закрывается после последнего хода.
type SharedProxy = { proxy: ReturnType<typeof createKimiEgressProxy>; refs: number };

const shared = new Map<string, SharedProxy>();

/** Один proxy делится параллельными ходами и закрывается после последнего. */
export async function acquireKimiEgressProxy(
  options: Parameters<typeof createKimiEgressProxy>[0],
) {
  const key = options.socketPath;
  let entry = shared.get(key);
  if (!entry) {
    const proxy = createKimiEgressProxy(options);
    await proxy.start();
    entry = { proxy, refs: 0 };
    shared.set(key, entry);
  }
  const held = entry;
  held.refs += 1;
  let released = false;
  return {
    proxy: held.proxy,
    async release() {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      shared.delete(key);
      await held.proxy.close();
    },
  };
}
