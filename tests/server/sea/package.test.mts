import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runFile } from './helperFixture.mts';
import { smokeRelease } from '../../../server/scripts/sea/smoke.mts';

test('SEA-PACKAGE-01: готовый комплект отвечает на служебные команды настоящим SEA', async () => {
  const root = process.env.GRIGDESK_SERVER_RELEASE_DIR;

  assert.ok(root, 'Укажите --release-dir через server run test:sea: отсутствие пакета не является skip');

  const binary = path.join(root, 'server/grigdesk-server');
  const manifest = JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8'));
  const env = { PATH: '/nonexistent' };
  const help = await runFile(binary, ['--help'], {
    cwd: '/',
    env,
    timeout: 10000,
  });
  const version = await runFile(binary, ['--version', '--json'], {
    cwd: '/',
    env,
    timeout: 10000,
  });
  const license = await runFile(binary, ['--license'], {
    cwd: '/',
    env,
    timeout: 10000,
  });
  const checked = await runFile(binary, ['--check-runtime'], {
    cwd: '/',
    env,
    timeout: 30000,
  });

  assert.match(help.stdout, /GrigDesk/);
  assert.equal(JSON.parse(version.stdout).version, manifest.version);
  assert.equal(JSON.parse(version.stdout).packagingVersion, 1);
  assert.equal(JSON.parse(version.stdout).node, 'v24.21.0');
  assert.match(license.stdout, /Node/);
  assert.equal(JSON.parse(checked.stdout).ok, true);
  assert.equal((await stat(binary)).mode & 0o111, 0o111);
  assert.equal((await readFile(binary)).subarray(1, 4).toString(), 'ELF');
});

test('SEA-PACKAGE-02: архив распаковывается отдельно, проходит manifest и настоящий boot', {
  timeout: 90000,
}, async (t) => {
  const release = process.env.GRIGDESK_SERVER_RELEASE_DIR;

  assert.ok(release, '--release-dir обязателен');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-archive-'));
  const basename = path.basename(release).replace(/-[a-f0-9]{16}$/, '');
  const archive = path.join(path.dirname(release), `${basename}.tar.xz`);

  t.after(() => rm(directory, { recursive: true, force: true }));
  await runFile('bash', ['-c', 'umask 022; tar -xJf "$1" -C "$2"', '_', archive, directory], {
    timeout: 30000,
  });

  const entries = await readdir(directory);

  assert.equal(entries.length, 1);

  const root = path.join(directory, entries[0]!);
  const checked = await runFile(path.join(root, 'server/grigdesk-server'), ['--check-runtime'], {
    cwd: '/',
    env: { PATH: '/nonexistent' },
    timeout: 30000,
  });

  assert.equal(JSON.parse(checked.stdout).ok, true);
  await smokeRelease(root);
});
