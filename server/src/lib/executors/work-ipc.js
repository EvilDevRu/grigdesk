import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORK_MCP = fileURLToPath(new URL('./work-mcp.js', import.meta.url));

/**
 * Приватный UDS привязывает MCP-процесс к конкретному server-owned workTools.
 * Nonce проверяется на каждом новом соединении и не передаётся модели как аргумент.
 */
export async function createWorkIpc({ workTools, root = os.tmpdir() }) {
  const dir = await fs.mkdtemp(path.join(root, 'cockpit-work-'));
  await fs.chmod(dir, 0o700);
  const socketPath = path.join(dir, 'work.sock');
  const nonce = randomUUID();
  const server = createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
    });
    socket.once('end', async () => {
      try {
        const request = JSON.parse(input.trim());
        if (request.nonce !== nonce) {
          throw new Error('work IPC nonce не совпал');
        }
        const result = await workTools.invoke(request.name, request.input || {});
        socket.end(`${JSON.stringify({ result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ error: String(error?.message || error) })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);

  return {
    socketPath,
    nonce,
    mcpServer: {
      command: process.execPath,
      args: [WORK_MCP, '--socket', socketPath, '--nonce', nonce],
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export default createWorkIpc;
