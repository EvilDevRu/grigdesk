import { Client } from 'ssh2';
import { createHash } from 'node:crypto';

function fingerprintFromHostHash(value) {
  const hash = String(value || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    return '';
  }

  return `SHA256:${Buffer.from(hash, 'hex').toString('base64')}`;
}

function callChannel(client, method, ...args) {
  return new Promise((resolve, reject) => {
    client[method](...args, (error, channel) => {
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
export function createSshTransport(options = {}) {
  const createClient = options.createClient || (() => new Client());

  async function connect(connection) {
    const client = createClient();
    const password = Buffer.isBuffer(connection.password)
      ? connection.password.toString('utf8')
      : String(connection.password || '');
    const connectOptions = {
      host: connection.host,
      port: Number(connection.port) || 22,
      username: connection.user || connection.username,
      password,
      readyTimeout: Number(connection.readyTimeout) || 20_000,
      ...(connection.hostVerifier
        ? {
          hostHash: 'sha256',
          hostVerifier: (hash) => connection.hostVerifier(fingerprintFromHostHash(hash)),
        }
        : {}),
    };
    await new Promise((resolve, reject) => {
      const onReady = () => {
        client.off('error', onError);
        resolve();
      };
      const onError = (error) => {
        client.off('ready', onReady);
        reject(error);
      };
      client.once('ready', onReady);
      client.once('error', onError);
      client.connect(connectOptions);
    });

    return {
      client,
      on: (...args) => client.on(...args),
      once: (...args) => client.once(...args),
      shell: (settings = {}) => callChannel(client, 'shell', settings),
      exec: (command, execOptions = {}) => callChannel(client, 'exec', command, execOptions),
      sftp: () => callChannel(client, 'sftp'),
      close: () => client.end(),
      end: () => client.end(),
      destroy: () => client.destroy?.(),
    };
  }

  async function probe(connection) {
    const client = createClient();
    let captured = null;
    await new Promise((resolve, reject) => {
      const finish = (error = null) => {
        client.end?.();
        if (captured) {
          resolve();
        } else if (error) {
          reject(error);
        }
      };
      client.once('ready', () => finish());
      client.once('error', (error) => finish(error));
      client.connect({
        host: connection.host,
        port: Number(connection.port) || 22,
        username: connection.user,
        readyTimeout: Number(connection.readyTimeout) || 20_000,
        hostVerifier(key) {
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
