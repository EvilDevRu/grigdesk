import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { helperCommand } from '../runtimePaths.ts';

// Реестр рабочих tools, который обслуживает этот IPC.
export interface WorkToolsPort {
  descriptors: unknown;
  invoke: (name: string, input: Record<string, unknown>) => Promise<unknown>;
}

// Выданный MCP-серверу приватный канал и его команда запуска.
export interface WorkIpc {
  socketPath: string;
  nonce: string;
  mcpServer: { command: string; args: string[]; env: Array<{ name: string; value: string }> };
  close: () => Promise<void>;
}

/**
 * Приватный UDS привязывает MCP-процесс к конкретному server-owned workTools.
 * Обрыв одного клиента закрывает его сокет и не прерывает сервер или начатый инструмент.
 */
export async function createWorkIpc({ workTools, root = os.tmpdir() }: {
  workTools: WorkToolsPort;
  root?: string;
}): Promise<WorkIpc> {
  const dir = await fs.mkdtemp(path.join(root, 'grigdesk-work-'));

  await fs.chmod(dir, 0o700);

  const socketPath = path.join(dir, 'work.sock');
  const nonce = randomUUID();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';

    socket.setEncoding('utf8');
    // EPIPE приходит асинхронным событием, вне try/catch обработки запроса.
    // Обработчик остаётся до закрытия сокета, включая передачу большого ответа.
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('data', (chunk) => {
      input += chunk;
    });
    socket.once('end', async () => {
      let output: string;

      try {
        const request = JSON.parse(input.trim());

        if (request.nonce !== nonce) {
          throw new Error('work IPC nonce не совпал');
        }

        const result = request.type === 'descriptors'
          ? workTools.descriptors
          : await workTools.invoke(request.name, request.input || {});

        output = JSON.stringify({ result });
      } catch (error) {
        output = JSON.stringify({
          error: String((error as { message?: unknown } | null)?.message || error),
        });
      }

      if (socket.destroyed || !socket.writable) {
        return;
      }

      socket.end(`${output}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await fs.chmod(socketPath, 0o600);

  const mcp = helperCommand('work-mcp', ['--socket', socketPath, '--nonce', nonce]);

  return {
    socketPath,
    nonce,
    mcpServer: {
      command: mcp.command,
      args: mcp.args,
      // ACP V1 требует поле даже при пустом наследуемом окружении.
      env: [],
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export default createWorkIpc;
