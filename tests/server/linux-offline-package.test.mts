import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildStableLinuxZip } from '../../tools/linuxOfflinePackage.mts';

const execute = promisify(execFile);
const expected = [
  'grigdesk-install', 'grigdesk-install.sha256', 'grigdesk-install.sig',
  'grigdesk-maintenance.gz', 'release.json', 'desktop.tar.gz', 'server.tar.gz', 'control.tar.gz',
];

test('LINUX-OFFLINE-ZIP: архив содержит только локальные файлы выпуска', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-zip-test-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  for (const file of [...expected, 'release-acceptance.json']) {
    await fs.writeFile(path.join(directory, file), `fixture:${file}\n`);
  }

  const output = await buildStableLinuxZip(directory, '1.2.3');

  assert.equal(path.basename(output), 'grigdesk-1.2.3-linux-x64-offline.zip');

  const listing = await execute('unzip', ['-Z1', output]);

  assert.deepEqual(listing.stdout.trim().split('\n').sort(), [...expected].sort());

  for (const file of expected) {
    const result = await execute('unzip', ['-p', output, file]);

    assert.equal(result.stdout, `fixture:${file}\n`);
  }

  await fs.rm(path.join(directory, 'server.tar.gz'));
  await assert.rejects(buildStableLinuxZip(directory, '1.2.4'), /offline_input_invalid/u);
  await assert.rejects(fs.stat(path.join(directory, 'grigdesk-1.2.4-linux-x64-offline.zip')),
    { code: 'ENOENT' });
});
