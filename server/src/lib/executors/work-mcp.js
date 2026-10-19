import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function toolDeclaration(descriptor) {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  };
}

/** MCP handler сериализует только уже очищенный provider-neutral результат. */
export function createWorkMcpHandler({ workTools }) {
  async function request(message) {
    const base = { jsonrpc: '2.0', id: message?.id };
    if (message?.method === 'initialize') {
      return {
        ...base,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'grigdesk-work', version: '1.0.0' },
        },
      };
    }
    if (message?.method === 'tools/list') {
      return {
        ...base,
        result: { tools: workTools.descriptors.map(toolDeclaration) },
      };
    }
    if (message?.method === 'tools/call') {
      const result = await workTools.invoke(
        String(message.params?.name || ''),
        message.params?.arguments || {},
      );
      return {
        ...base,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false,
        },
      };
    }
    return {
      ...base,
      error: { code: -32601, message: `Метод ${message?.method || '?'} не поддерживается` },
    };
  }

  return { request, handle: request };
}

async function ipcRequest(socketPath, nonce, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.end(`${JSON.stringify({ nonce, ...request })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.once('error', reject);
    socket.once('close', () => {
      try {
        const response = JSON.parse(buffer || '{}');
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.result);
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runCli() {
  const socketIndex = process.argv.indexOf('--socket');
  const nonceIndex = process.argv.indexOf('--nonce');
  const socketPath = socketIndex >= 0 ? process.argv[socketIndex + 1] : '';
  const nonce = nonceIndex >= 0 ? process.argv[nonceIndex + 1] : '';
  const descriptors = await ipcRequest(socketPath, nonce, { type: 'descriptors' });
  const handler = createWorkMcpHandler({
    workTools: {
      descriptors: Array.isArray(descriptors) ? descriptors : [],
      invoke: (name, input) => ipcRequest(socketPath, nonce, { name, input }),
    },
  });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let response;
    try {
      const message = JSON.parse(line);
      // JSON-RPC notification подтверждать нельзя: лишний ответ с null/пустым id
      // ломает строгие MCP-клиенты после initialize.
      if (!Object.hasOwn(message, 'id')) {
        continue;
      }
      response = await handler.request(message);
    } catch (error) {
      response = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: String(error?.message || error) },
      };
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

/**
 * Точка входа собранного helper-а: обслуживает MCP поверх stdio.
 * Параметры сокета и nonce остаются в argv, как у прямого запуска исходника.
 */
export async function main() {
  return runCli();
}

// Kimi contained монтирует только этот файл, без соседних модулей.
// Маркер собранного entry исключает повторный вызов main после esbuild.
if (!globalThis.__grigdeskHelperEntry && process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export default createWorkMcpHandler;
