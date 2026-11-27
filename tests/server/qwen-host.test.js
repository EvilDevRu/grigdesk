import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { qwenNativeFixture } from '../helpers/qwenNativeFixture.mjs';
import { qwenAdapter, qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen Preview.2 Host: настройки владельца неизменны, временный профиль удалён', {
  skip: !process.env.GRIGDESK_TEST_QWEN_SESSION_BUS && 'Требуется пользовательская область GrigDesk',
}, async (t) => {
  const fixture = await qwenNativeFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const original = await readFile(fixture.file, 'utf8');
  const spec = runInput(fixture, 'shared-model(openai)', { providerSettings: { allowHostAccess: true } });
  const handle = await adapter.session.open(spec);

  fixture.onCleanup(() => handle.close());
  await handle.send({ message: 'Проверка.', signal: AbortSignal.timeout(12000) });
  await handle.close();

  assert.equal(await readFile(fixture.file, 'utf8'), original);

  const files = await readdir(fixture.config.qwenRuntimeHome, { recursive: true });

  assert.equal(files.some((file) => file.split('/').some((part) => part.startsWith('turn-'))), false);
});

test('Qwen Preview.2 Host: разовый запуск требует живую сессию', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });

  await assert.rejects(adapter.run(runInput(fixture, 'shared-model(openai)', {
    providerSettings: { allowHostAccess: true },
  })), { code: 'host_persistent_required' });
});
