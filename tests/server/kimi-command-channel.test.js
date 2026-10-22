import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import test from 'node:test';

import { createKimiCommandChannel } from '../../server/src/lib/kimi/commandChannel.ts';

/**
 * Синтетический клиент говорит тем же IPC, которым пользуется work-mcp.
 * Команда возвращает verdict; внешние SSH/DB-процессы здесь не запускаются.
 */
function call(channel, nonce, input) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(channel.socketPath);
    let text = '';

    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(JSON.stringify({
      nonce,
      name: 'run_command',
      input,
    })));
    socket.on('data', (part) => {
      text += part;
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(JSON.parse(text)));
  });
}

test('приватный MCP закрывает внешний DB-клиент и не принимает неверный nonce', async (t) => {
  const channel = await createKimiCommandChannel({
    cwd: process.cwd(),
    env: {},
    settings: { blockDirectDb: true },
    permissionMode: 'yolo',
    commandsAllowed: true,
    nativeGuard: async () => true,
  });

  t.after(() => channel.close());

  const denied = await call(channel, channel.nonce, { command: 'mysql -h db.example.invalid' });
  const wrong = await call(channel, 'wrong', { command: 'printf ok' });

  assert.equal(denied.result.error, 'direct_command_denied');
  assert.equal(typeof wrong.error, 'string');
  assert.equal(channel.mcpServer.name, 'grigdesk-command');
});
