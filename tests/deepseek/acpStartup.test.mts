import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createAcpClient } from '../../server/src/lib/acp/client.ts';
import { initializeDeepSeekAcp } from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';

const workerSource = `
import { createInterface } from 'node:readline';

process.send({ boot: 'blocked' });
process.once('message', () => {
  let received = 0;
  const reader = createInterface({ input: process.stdin });

  reader.on('line', (line) => {
    const request = JSON.parse(line);

    received += 1;
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { protocolVersion: 1, received },
    }) + '\\n');
  });
});
`;

/**
 * Одноразовый worker держит настоящий stdin без reader до отдельного IPC-разрешения.
 * Окружение не содержит ключей, модель и Harness не нужны для проверки буферизации pipe.
 */
async function startupWorker(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deepseek-acp-startup-'));
  const entry = path.join(root, 'worker.mjs');

  await writeFile(entry, workerSource);

  const child = spawn(process.execPath, [entry], {
    env: {
      HOME: root,
      PATH: '',
      NODE_V8_COVERAGE: '',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const booted = new Promise<void>((resolve) => child.once('message', () => resolve()));
  const client = createAcpClient(child);

  t.after(async () => {
    client.close();
    child.kill('SIGTERM');
    await closed;
    await rm(root, { recursive: true, force: true });
  });

  await booted;

  return { child, client };
}

test('ACP cold start: первое stdin ждёт reader, initialize отправляется один раз', async (t) => {
  const { child, client } = await startupWorker(t);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const pending = initializeDeepSeekAcp(client);

    // Холодная подготовка ещё держит reader за барьером, kernel pipe хранит первую строку.
    // Продвигаем прежний десятисекундный срок без сна, модели и provider credentials.
    t.mock.timers.tick(10_001);
    await nextTurn();
    child.send({ boot: 'release' });

    const reply = await pending as { protocolVersion: number; received: number };

    assert.equal(reply.protocolVersion, 1);
    assert.equal(reply.received, 1, 'INITIALIZE_SENT_ONCE_DURING_COLD_START');
  } finally {
    t.mock.timers.reset();
  }
});

test('ACP cold start: единый бюджет конечен, молчащий worker не вызывает повтор', async (t) => {
  const { client } = await startupWorker(t);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const pending = initializeDeepSeekAcp(client);
    const rejected = assert.rejects(pending, /ACP timeout: initialize/u);
    let settled = false;

    void pending.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    t.mock.timers.tick(119_999);
    await nextTurn();
    assert.equal(settled, false, 'Холодный старт сохраняет один ожидающий запрос до deadline');

    t.mock.timers.tick(1);
    await rejected;
    assert.equal(settled, true);
  } finally {
    t.mock.timers.reset();
  }
});
