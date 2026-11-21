import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { fixtureGo } from '../helpers/goBuildFixture.mts';

const execute = promisify(execFile);

test('MAINTENANCE-METADATA: метаданные доступны без установки', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-maintenance-info-'));

  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const { stdout, stderr } = await execute(fixtureGo('grigdesk-maintenance'), ['--runtime-info', '--json'], {
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    timeout: 30_000,
  });

  assert.deepEqual(JSON.parse(stdout), {
    schema: 1,
    kind: 'grigdesk-maintenance',
    version: (await fs.readFile(new URL('../../VERSION', import.meta.url), 'utf8')).trim(),
    os: process.platform,
    arch: process.arch === 'x64' ? 'amd64' : process.arch,
    go: 'go1.27.4',
    runtime: 'go',
  });
  assert.equal(stderr, '');
  assert.deepEqual(await fs.readdir(home), []);
});
