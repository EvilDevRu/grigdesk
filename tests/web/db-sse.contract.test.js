import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('четыре DB-инвалидации входят в единственную SSE-подписку вкладки', async () => {
  const source = await readFile(
    new URL('../../web/src/composables/useSse.ts', import.meta.url),
    'utf8',
  );
  const list = source.match(/const EVENT_NAMES = \[([\s\S]*?)\];/);
  assert.ok(list, 'список единственной SSE-подписки не найден');
  const names = new Set([...list[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]));
  const expected = ['db-sessions', 'db-queries', 'db-audit', 'db-permission'];

  assert.deepEqual(expected.filter((name) => !names.has(name)), []);
});
