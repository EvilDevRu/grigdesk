import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WEB_SSE_SIGNALS } from '../../shared/web-log/webDiagnostics.ts';

test('четыре DB-инвалидации входят в единственную SSE-подписку вкладки', async () => {
  const source = await readFile(
    new URL('../../web/src/composables/useSse.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const EVENT_NAMES = WEB_SSE_SIGNALS;/u);

  const names = new Set(WEB_SSE_SIGNALS);
  const expected = ['db-sessions', 'db-queries', 'db-audit', 'db-permission'];

  assert.deepEqual(expected.filter((name) => !names.has(name)), []);
});
