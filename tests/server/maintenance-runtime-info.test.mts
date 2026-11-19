import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('MAINTENANCE-METADATA: метаданные доступны без установки', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-maintenance-info-'));

  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const source = fileURLToPath(new URL('../../tools/maintenance.mts', import.meta.url));
  const { stdout } = await execute(process.execPath, [source, '--runtime-info', '--json'], {
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    timeout: 30_000,
  });

  assert.deepEqual(JSON.parse(stdout), {
    kind: 'grigdesk-maintenance',
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    sea: false,
  });
  assert.deepEqual(await fs.readdir(home), []);
});
