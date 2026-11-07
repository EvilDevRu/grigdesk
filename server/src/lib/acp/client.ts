import type { ChildProcess } from 'node:child_process';

type JsonRpcId = string | number | null;

interface AcpMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface AcpClient {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
  close: () => void;
  readonly closed: boolean;
}

export class AcpRpcError extends Error {
  readonly code: number | undefined;

  readonly data: unknown;

  readonly method: string;

  constructor(error: { message?: string; code?: number; data?: unknown } | undefined, method: string) {
    super(error?.message || `ACP request failed: ${method}`);
    this.name = 'AcpRpcError';
    this.code = error?.code;
    this.data = error?.data;
    this.method = method;
  }
}

/** NDJSON JSON-RPC client для ACP. Reverse requests обрабатываются независимо от reader loop. */
export function createAcpClient(child: ChildProcess, {
  onNotification,
  onReverseRequest,
  requestTimeoutMs = 24 * 60 * 60 * 1000,
  maxLineBytes = 8 * 1024 * 1024,
}: {
  onNotification?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onReverseRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
} = {}): AcpClient {
  let nextId = 1;
  let closed = false;
  let buffer = Buffer.alloc(0);
  // Responses ждут все предыдущие notifications, чтобы runtime видел chunks до
  // завершения request. Reverse request стартует после уже принятых сообщений,
  // но не занимает этот tail: новые updates продолжают приниматься во время UI-вопроса.
  let dispatchTail: Promise<unknown> = Promise.resolve();
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
  }>();

  function send(message: AcpMessage): void {
    if (closed || child.stdin?.destroyed || !child.stdin) {
      throw new Error('ACP transport закрыт');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function settleAll(error: unknown): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function removeListeners(): void {
    child.stdout?.off('data', onData);
    child.stdout?.off('end', onEnd);
    child.off('error', onError);
    child.off('exit', onExit);
  }

  function closeWith(error: unknown): void {
    if (closed) return;
    closed = true;
    removeListeners();
    settleAll(error);
  }

  function respond(message: AcpMessage, response: AcpMessage): void {
    if (!Object.hasOwn(message, 'id') || closed) return;
    try {
      send({ jsonrpc: '2.0', id: message.id, ...response });
    } catch {
      // EOF/cancel мог опередить поздний ответ человека — транспорт уже закрыт.
    }
  }

  function consume(message: AcpMessage): void {
    if (!message || message.jsonrpc !== '2.0') return;

    if (Object.hasOwn(message, 'id') && !message.method) {
      dispatchTail = dispatchTail.then(() => {
        const numericId = typeof message.id === 'number' ? message.id : Number.NaN;
        const entry = pending.get(numericId);
        if (!entry) return;
        pending.delete(numericId);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new AcpRpcError(message.error, entry.method));
        else entry.resolve(message.result);
      }).catch(() => undefined);
      return;
    }

    if (message.method && Object.hasOwn(message, 'id')) {
      if (!onReverseRequest) {
        respond(message, {
          error: { code: -32601, message: `Неизвестный reverse method: ${message.method}` },
        });
        return;
      }
      const preceding = dispatchTail;
      void preceding
        .then(() => onReverseRequest(message.method as string, message.params))
        .then((result) => respond(message, { result }))
        .catch((error) => respond(message, {
          error: {
            code: -32603,
            message: String((error as { message?: unknown } | null)?.message || 'Client error'),
          },
        }));
      return;
    }

    if (message.method && onNotification) {
      dispatchTail = dispatchTail
        .then(() => onNotification(message.method as string, message.params))
        .catch(() => undefined);
    }
  }

  function failOversize(): void {
    closeWith(new Error('ACP line превысила лимит'));
    child.kill('SIGTERM');
  }

  function onData(chunk: Buffer | string): void {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > maxLineBytes && buffer.indexOf(0x0a) < 0) {
      failOversize();
      return;
    }

    let newline = buffer.indexOf(0x0a);
    while (newline >= 0) {
      if (newline > maxLineBytes) {
        failOversize();
        return;
      }
      const text = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (text.startsWith('{')) {
        try {
          consume(JSON.parse(text) as AcpMessage);
        } catch {
          // Невалидный входной frame не может подменить ожидаемый response.
        }
      }
      newline = buffer.indexOf(0x0a);
    }
  }

  function onEnd(): void {
    const error = new Error(buffer.length > 0
      ? 'ACP transport завершился с неполным frame'
      : 'ACP transport завершился');
    void dispatchTail.finally(() => closeWith(error));
  }

  function onError(error: unknown): void {
    closeWith(error);
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // `close`/stdout EOF могут никогда не наступить, если tool-child унаследовал
    // pipe уже завершившегося ACP-процесса. Даём очереди data один turn на
    // обработку последнего frame, после чего считаем transport окончательно
    // закрытым и освобождаем свои концы pipe.
    setImmediate(() => {
      if (closed) return;
      closeWith(new Error(
        `ACP process завершился (${signal || String(code ?? 'unknown')})`,
      ));
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
  }

  child.stdout?.on('data', onData);
  child.stdout?.once('end', onEnd);
  child.once('error', onError);
  child.once('exit', onExit);

  return {
    request(method: string, params: unknown = {}, timeoutMs = requestTimeoutMs) {
      if (closed) return Promise.reject(new Error('ACP transport закрыт'));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP timeout: ${method}`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer, method });
        try {
          send({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method: string, params: unknown = {}) {
      send({ jsonrpc: '2.0', method, params });
    },
    close() {
      if (closed) return;
      try { child.stdin?.end(); } catch { /* транспорт уже завершён */ }
      closeWith(new Error('ACP client закрыт'));
    },
    get closed() { return closed; },
  };
}

export function initializeAcp(client: AcpClient, timeoutMs = 15_000): Promise<unknown> {
  return client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
    },
    clientInfo: { name: 'GrigDesk', version: '1' },
  }, timeoutMs);
}
