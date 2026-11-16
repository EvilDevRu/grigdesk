import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { qwenAdapter, qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

test('Qwen Host: исходные settings неизменны, model selection не сохраняет default', async (t) => {
  const fixture = await qwenFixture(t);
  const adapter = await qwenAdapter({ runnable: true });
  const original = await readFile(fixture.file, 'utf8');

  await fixture.fake({ metadata: { 'shared-model(openai)': { context: 32768 } } });

  const spec = runInput(fixture, 'shared-model(openai)', { providerSettings: { allowHostAccess: true } });
  const handle = adapter.session?.open ? await adapter.session.open(spec) : {
    send: (turn) => adapter.run({ ...spec, ...turn }),
    close: async () => {},
  };

  t.after(() => handle.close());
  await handle.send({ message: 'Проверка.', signal: AbortSignal.timeout(12000) });
  await handle.close();

  const records = await fixture.records();

  assert.equal(await readFile(fixture.file, 'utf8'), original);
  assert.equal(records.find((entry) => entry.event === 'handshake').provider, undefined);
  assert.equal(records.find((entry) => entry.event === 'handshake').guard, 'required-v1');
  assert.equal(records.some((entry) => entry.frame?.method === 'session/set_model'), false);

  const files = await readdir(fixture.config.qwenRuntimeHome, { recursive: true });

  assert.equal(files.some((file) => /host-[^/]+\/settings.json$/.test(file)), false,
    'Временные settings очищены после close');
});
