import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startBrowserSocket, requestBrowserSocket } from '../../server/src/lib/browser/browserSocket.ts';

test('BR18: socket проверяет proof до invoke и ограничивает сообщения', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-socket-'));
  const calls: unknown[] = [];
  const server = await startBrowserSocket({
    file: path.join(root, 'broker.sock'),
    probe: () => ({ mode: 'grigdesk', available: false }),
    owner: async (proof: unknown) => {
      if (!proof || typeof proof !== 'object' || (proof as { token?: string }).token !== 'valid') {
        throw new Error('browser_run_stale');
      }

      return 'task:own';
    },
    invoke: async (owner: unknown, input: unknown) => {
      calls.push([owner, input]);

      return { ok: true };
    },
  });

  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(await requestBrowserSocket(server.file, {
    schema: 1,
    proof: { token: 'valid' },
    input: { action: 'probe' },
  }), { mode: 'grigdesk', available: false });
  assert.equal(calls.length, 0);

  const result = await requestBrowserSocket(server.file, {
    schema: 1,
    proof: { token: 'valid' },
    input: { action: 'list' },
  });

  assert.deepEqual(result, { ok: true });
  await assert.rejects(() => requestBrowserSocket(server.file, {
    schema: 1,
    proof: { token: 'invalid' },
    input: { action: 'list' },
  }), /browser_run_stale/u);
  assert.equal(calls.length, 1);
});
