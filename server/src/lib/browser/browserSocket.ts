import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';

const INPUT_LIMIT = 65536;
const OUTPUT_LIMIT = 3 * 1024 * 1024;

/**
 * Один запрос соответствует одному короткоживущему соединению с private UDS.
 * Timeout или разрыв не повторяет запрос, поскольку сайт мог уже принять действие.
 */
export function requestBrowserSocket(file: string, value: unknown, signal?: AbortSignal) {
  const input = JSON.stringify(value) + '\n';

  if (Buffer.byteLength(input) > INPUT_LIMIT) {
    return Promise.reject(new Error('browser_request_too_large'));
  }

  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(file);
    let output = '';
    const abort = () => socket.destroy(new Error('browser_cancelled'));
    const timer = setTimeout(() => socket.destroy(new Error('outcome_unknown')), 15000);

    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      if (signal?.aborted) {
        abort();
      } else {
        socket.end(input);
      }
    });
    socket.on('data', (chunk) => {
      output += chunk;

      if (Buffer.byteLength(output) > OUTPUT_LIMIT) {
        socket.destroy(new Error('browser_result_too_large'));
      }
    });
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);

      try {
        const response = JSON.parse(output);

        if (response.ok !== true) {
          throw new Error(typeof response.error === 'string' ? response.error : 'browser_unavailable');
        }

        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Socket не имеет регистратора host или инструмента произвольной команды.
 * Proof проверяет серверный resolver, а input проходит отдельный action parser.
 */
export async function startBrowserSocket(options: {
  file: string;
  owner(proof: unknown): Promise<string>;
  probe?(proof: unknown): Promise<{
    mode: 'legacy' | 'grigdesk';
    available: boolean;
    evidenceRoot?: string
  }> | {
      mode: 'legacy' | 'grigdesk';
      available: boolean;
      evidenceRoot?: string
    };
  evidence?(proof: unknown, result: unknown): Promise<unknown>;
  invoke(owner: string, input: unknown, signal: AbortSignal,
    authorize: () => Promise<boolean>): Promise<unknown>;
}) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);

    const abort = new AbortController();
    let input = '';
    let answered = false;

    socket.setEncoding('utf8');
    socket.setTimeout(16000, () => socket.destroy());
    socket.once('error', () => abort.abort());
    socket.once('close', () => {
      sockets.delete(socket);
      abort.abort();
    });
    socket.on('data', (chunk) => {
      input += chunk;

      if (Buffer.byteLength(input) > INPUT_LIMIT) {
        socket.destroy();
      }
    });
    socket.once('end', async () => {
      if (answered || socket.destroyed) {
        return;
      }

      answered = true;

      try {
        const request = JSON.parse(input);

        if (!request || request.schema !== 1
          || Object.keys(request).sort().join(',') !== 'input,proof,schema') {
          throw new Error('browser_request_invalid');
        }

        const owner = await options.owner(request.proof);
        /**
         * Повторная проверка использует тот же proof и ожидаемого owner запроса.
         * Потеря authority запрещает выдачу и принятие результата команды.
         */
        const authorize = async () => {
          try {
            return await options.owner(request.proof) === owner;
          } catch {
            return false;
          }
        };
        const probe = request.input && typeof request.input === 'object'
          && !Array.isArray(request.input)
          && Object.keys(request.input).join(',') === 'action'
          && request.input.action === 'probe';

        if (!await authorize()) {
          throw new Error('browser_run_stale');
        }

        const nativeResult = probe
          ? await options.probe?.(request.proof) ?? { mode: 'legacy', available: false }
          : await options.invoke(owner, request.input, abort.signal, authorize);

        if (!await authorize()) {
          throw new Error('browser_run_stale');
        }

        const result = !probe && options.evidence
          ? await options.evidence(request.proof, nativeResult) : nativeResult;
        const output = JSON.stringify({ ok: true, result });

        if (Buffer.byteLength(output) > OUTPUT_LIMIT) {
          throw new Error('browser_result_too_large');
        }

        socket.end(output);
      } catch (error) {
        const message = (error as Error).message;
        const code = /^(browser_[a-z_]+|outcome_unknown|access_revoked)$/u.test(message)
          ? message : 'browser_unavailable';

        socket.end(JSON.stringify({ ok: false, error: code }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.file, resolve);
  });
  await chmod(options.file, 0o600);

  const inode = (await lstat(options.file)).ino;

  return {
    file: options.file,
    /**
     * Закрытие завершает только соединения собственного listener.
     * Путь удаляется лишь при совпадении сохранённого socket inode.
     */
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));

      const current = await lstat(options.file).catch(() => null);

      if (current?.isSocket() && current.ino === inode) {
        await unlink(options.file);
      }
    },
  };
}
