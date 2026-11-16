/// <reference path="../../types/ssh2.d.ts" />
// Объявление ssh2 подключается ссылкой, а не через include проекта: файл транспорта
// попадает в разные наборы проверки, и типы библиотеки обязаны приезжать вместе с ним.
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import type { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

export interface SshTransportConnection {
  host: string;
  port?: number;
  user?: string;
  username?: string;
  password?: Buffer | string;
  privateKey?: Buffer | string;
  passphrase?: string;
  readyTimeout?: number;
  hostVerifier?: (fingerprint: string) => boolean;
}

// Живое соединение как его видит менеджер сессий: канал оболочки, канал команды и
// туннель принадлежат одному клиенту, поэтому и закрываются вместе с ним.
export interface SshTransportSession {
  client: Client;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  shell: (settings?: Record<string, unknown>) => Promise<ClientChannel>;
  exec: (command: string, execOptions?: Record<string, unknown>) => Promise<ClientChannel>;
  sftp: () => Promise<SFTPWrapper>;
  forwardOut: (target: { host: string; port: number }) => Promise<ClientChannel>;
  close: () => void;
  end: () => void;
  destroy: () => void;
}

export interface ProbedHostKey {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface SshTransportOptions {
  createClient?: () => Client;
}

export interface SshTransport {
  connect: (connection: SshTransportConnection) => Promise<SshTransportSession>;
  probe: (connection: SshTransportConnection) => Promise<ProbedHostKey | null>;
}

function fingerprintFromHostHash(value: unknown): string {
  const hash = String(value || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    return '';
  }

  return `SHA256:${Buffer.from(hash, 'hex').toString('base64')}`;
}

function callChannel<Channel>(
  client: Client,
  method: 'shell' | 'exec' | 'sftp',
  ...args: unknown[]
): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const call = client[method] as (...rest: unknown[]) => void;
    call.call(client, ...args, (error: Error | undefined, channel: Channel) => {
      if (error) {
        reject(error);
      } else {
        resolve(channel);
      }
    });
  });
}

/**
 * Transport использует только ssh2.Client. Пароль передаётся библиотеке в памяти
 * процесса и не пересекает argv, env или системный дочерний процесс.
 */
export function createSshTransport(options: SshTransportOptions = {}): SshTransport {
  const createClient = options.createClient || (() => new Client());

  async function connect(connection: SshTransportConnection): Promise<SshTransportSession> {
    const client = createClient();
    const password = Buffer.isBuffer(connection.password)
      ? connection.password.toString('utf8')
      : String(connection.password || '');
    const verifier = connection.hostVerifier;
    const connectOptions: ConnectConfig = {
      host: connection.host,
      port: Number(connection.port) || 22,
      username: connection.user || connection.username,
      ...(connection.privateKey
        ? { privateKey: connection.privateKey, passphrase: connection.passphrase }
        : { password }),
      readyTimeout: Number(connection.readyTimeout) || 20_000,
      ...(verifier
        ? {
          hostHash: 'sha256',
          hostVerifier: (hash: Buffer | string) => verifier(fingerprintFromHostHash(hash)),
        }
        : {}),
    };

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        resolve();
      };
      const onError = (error: unknown) => {
        client.off('ready', onReady);
        // ssh2 продолжает выдавать error после ready; соединение закрывается без
        // необработанного события, даже пока потребитель ещё не получил session.
        client.destroy?.();
        reject(error);
      };
      client.once('ready', onReady);
      client.on('error', onError);
      client.connect(connectOptions);
    });
    const emitter = client as EventEmitter;

    return {
      client,
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      once: (event, listener) => {
        emitter.once(event, listener);
      },
      shell: (settings = {}) => callChannel<ClientChannel>(client, 'shell', settings),
      exec: (command, execOptions = {}) => (
        callChannel<ClientChannel>(client, 'exec', command, execOptions)
      ),
      sftp: () => callChannel<SFTPWrapper>(client, 'sftp'),
      forwardOut: ({ host, port }) => new Promise<ClientChannel>((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, String(host), Number(port), (error, channel) => {
          if (error) reject(error);
          else resolve(channel);
        });
      }),
      close: () => client.end(),
      end: () => client.end(),
      destroy: () => client.destroy?.(),
    };
  }

  async function probe(connection: SshTransportConnection): Promise<ProbedHostKey | null> {
    const client = createClient();
    let captured: ProbedHostKey | null = null;
    await new Promise<void>((resolve, reject) => {
      const finish = (error: unknown = null) => {
        client.end?.();
        if (captured) {
          resolve();
        } else if (error) {
          reject(error);
        }
      };
      client.once('ready', () => finish());
      client.once('error', (error: unknown) => finish(error));
      client.connect({
        host: connection.host,
        port: Number(connection.port) || 22,
        username: connection.user,
        readyTimeout: Number(connection.readyTimeout) || 20_000,
        hostVerifier(key: Buffer | string) {
          const raw = Buffer.from(key);
          const nameLength = raw.length >= 4 ? raw.readUInt32BE(0) : 0;
          const algorithm = nameLength > 0 && nameLength <= raw.length - 4
            ? raw.subarray(4, 4 + nameLength).toString('ascii')
            : 'unknown';
          captured = {
            host: connection.host,
            port: Number(connection.port) || 22,
            algorithm,
            fingerprint: `SHA256:${createHash('sha256').update(raw).digest('base64')}`,
          };
          return false;
        },
      });
    });
    return captured;
  }

  return { connect, probe };
}

export default createSshTransport;
