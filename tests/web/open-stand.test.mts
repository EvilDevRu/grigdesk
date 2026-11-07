import assert from 'node:assert/strict';
import test from 'node:test';
import { openStand } from '../../web/src/shared/browser/openStand.ts';

test('BR11: настройка и разовый override, native отказ не запускает второй браузер', async () => {
  const calls: unknown[] = [];
  const port = {
    available: true,
    preferences: {
      open: 'internal' as const,
      external: 'app:ff',
      agents: false
    },
    native: async (value: unknown) => {
      calls.push(value);
    },
  };

  await openStand(port, 'http://localhost:5191/');
  await openStand(port, 'http://localhost:5191/', 'external');
  await openStand(port, 'http://localhost:5191/', 'internal', false);
  assert.deepEqual(calls, [
    {
      operation: 'open',
      url: 'http://localhost:5191/',
      target: 'internal',
      deduplicate: true
    },
    {
      operation: 'open',
      url: 'http://localhost:5191/',
      target: 'external',
      deduplicate: true
    },
    {
      operation: 'open',
      url: 'http://localhost:5191/',
      target: 'internal',
      deduplicate: false
    },
  ]);
  assert.equal(await openStand({ ...port, available: false }, 'http://localhost:5191/'), false);
  await assert.rejects(() => openStand({
    ...port, native: async () => {
      throw new Error('browser_app_missing');
    },
  }, 'http://localhost:5191/'), /browser_app_missing/u);
});
