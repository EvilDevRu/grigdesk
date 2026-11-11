import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ensureTestDeepSeekBinary, testDeepSeekRuntimeDependencies } from '../helpers/deepseekBinary.mts';
import { oldTree, retentionFixture, treeSnapshot } from '../helpers/deepseekRetentionFixture.mts';

test('HB-EXPLICIT: выбранные binary/cache/payload проходят metadata и полный verify', async (t) => {
  const box = await retentionFixture(t);
  const result = await ensureTestDeepSeekBinary();
  const calls = (await fs.readFile(box.calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(result.binary, box.binary);
  assert.equal(result.cacheDir, box.cache);
  assert.equal(result.payloadFile, box.payload);
  assert.deepEqual(result.info, box.info);
  assert.deepEqual(calls.map((call) => call.args), [
    ['--runtime-info', '--json'],
    ['--cache-dir', box.cache, '--verify', '--json'],
  ]);
});

for (const control of [{ packageId: 'f'.repeat(64) }, { verified: false }, { exit: 9 }]) {
  test(`HB-VERIFY: отказ integrity ${JSON.stringify(control)} отклоняет подготовку`, async (t) => {
    const box = await retentionFixture(t);

    await fs.writeFile(box.control, JSON.stringify(control));
    await assert.rejects(ensureTestDeepSeekBinary());
  });
}

test('HB-DEPS: чтение неподготовленных dependencies не чинит cache и не убирает old', async (t) => {
  const box = await retentionFixture(t);
  const missing = path.join(box.root, 'node-cache');

  await oldTree(box.root, 'test-builds/old');
  process.env.GRIGDESK_DEEPSEEK_NODE_CACHE = missing;

  const before = await treeSnapshot(box.root);

  await assert.rejects(testDeepSeekRuntimeDependencies(), {
    message: 'Подготовьте dependencies pinned Node: npm --prefix deepseek run prepare:runtime -- '
      + `--node-cache-dir ${missing}`,
  });
  assert.deepEqual(await treeSnapshot(box.root), before);
});
