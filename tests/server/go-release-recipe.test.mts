import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildReleaseUtility } from '../../tools/goReleaseUtility.mts';

const execute = promisify(exec);

test('GO-RELEASE: внешний staging tracker выпускает Go ELF, запускаемый с пустым PATH', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-release-go-'));

  t.after(() => rm(directory, { force: true, recursive: true }));

  const output = path.join(directory, 'tracker');
  const version = '0.2.1';

  await buildReleaseUtility('tracker', {
    root: path.resolve(import.meta.dirname, '../..'),
    output,
    cache: path.join(directory, 'cache'),
    version,
    env: process.env,
  });

  const result = await execute(output, ['--runtime-info', '--json'], { env: { PATH: directory } });
  const runtime = JSON.parse(result.stdout);

  assert.equal(runtime.kind, 'tracker');
  assert.equal(runtime.runtime, 'go');
  assert.equal(runtime.version, version);
  assert.equal(result.stderr, '');
});
