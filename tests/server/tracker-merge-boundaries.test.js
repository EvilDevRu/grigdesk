import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateDriverPackage } from '../../server/src/lib/trackers/driverPackage.ts';

/**
 * Проверка манифеста не импортирует точку входа и не требует git-репозитория.
 * Системным остаётся только own, а прежнее поле legacy запрещено даже с пустым значением.
 */
async function packageFixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tracker-merge-package-'));

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'driver.json'), JSON.stringify({
    id: 'grigdesk-b24',
    name: 'Битрикс24',
    version: '1.0.0',
    contract: 1,
    settings: {},
    ...extra,
  }));
  await writeFile(path.join(directory, 'driver.ts'), 'throw new Error("не импортировать");\n');

  return () => validateDriverPackage(directory, {
    version: '1.0.0',
    expectedId: null,
    reservedIds: new Set(['own']),
    grigDeskVersion: '1.0.0',
  });
}

for (const legacy of [true, false, null]) {
  test(`MERGE-MANIFEST: legacy=${legacy} запрещён`, async (t) => {
    const validate = await packageFixture(t, { legacy });

    await assert.rejects(validate(), { code: 'manifest_invalid' });
  });
}

test('MERGE-MANIFEST: stock является обычным внешним пакетом', async (t) => {
  const validate = await packageFixture(t);

  assert.equal((await validate()).id, 'grigdesk-b24');
});
