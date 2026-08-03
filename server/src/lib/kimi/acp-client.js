export class AcpRpcError extends Error {
  constructor(error, method) {
    super(error?.message || `ACP request failed: ${method}`);
    this.name = 'AcpRpcError';
    this.code = error?.code;
    this.data = error?.data;
    this.method = method;
  }
}

/** Маленький NDJSON JSON-RPC client: ACP SDK серверу Cockpit не требуется. */
export function createAcpClient(child, {
  onNotification,
  onReverseRequest,
  requestTimeoutMs = 24 * 60 * 60 * 1000,
  maxLineBytes = 8 * 1024 * 1024,
} = {}) {
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let consumeTail = Promise.resolve();

  function send(message) {
    if (closed || child.stdin.destroyed) throw new Error('ACP transport закрыт');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function settleAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  async function consume(message) {
    if (!message || message.jsonrpc !== '2.0') return;
    if (Object.hasOwn(message, 'id') && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new AcpRpcError(message.error, entry.method));
      else entry.resolve(message.result);
      return;
    }
    if (message.method && Object.hasOwn(message, 'id')) {
      try {
        const result = await onReverseRequest?.(message.method, message.params) ?? {
          outcome: { outcome: 'cancelled' },
        };
        send({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error?.message || 'Client error' } });
      }
      return;
    }
    if (message.method) await onNotification?.(message.method, message.params);
  }

  function closeWith(error) {
    if (closed) return;
    closed = true;
    settleAll(error);
  }

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > maxLineBytes && buffer.indexOf(0x0a) < 0) {
      closeWith(new Error('ACP line превысила лимит'));
      child.kill('SIGTERM');
      return;
    }
    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      if (newline > maxLineBytes) {
        closeWith(new Error('ACP line превысила лимит'));
        child.kill('SIGTERM');
        return;
      }
      const text = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (!text.startsWith('{')) continue;
      let message;
      try { message = JSON.parse(text); } catch { continue; }
      consumeTail = consumeTail.then(() => consume(message)).catch(() => {});
    }
  });
  child.stdout.once('end', () => {
    closeWith(new Error('ACP transport завершился'));
  });
  child.once('error', (error) => {
    closeWith(error);
  });

  return {
    request(method, params = {}, timeoutMs = requestTimeoutMs) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP timeout: ${method}`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer, method });
        try { send({ jsonrpc: '2.0', id, method, params }); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params = {}) {
      send({ jsonrpc: '2.0', method, params });
    },
    close() {
      if (closed) return;
      child.stdin.end();
    },
    get closed() { return closed; },
  };
}

export function initializeKimiAcp(client) {
  return client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
    },
    clientInfo: { name: 'Cockpit', version: '1' },
  }, 15_000);
}
