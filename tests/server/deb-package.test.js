import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildDeb } from '../../tools/buildDeb.mts';
import { signedIndex } from '../helpers/releaseV2Fixture.mjs';

const execute = promisify(execFile);
const hasDpkg = spawnSync('dpkg-deb', ['--version']).status === 0;

/**
 * Фикстура артефактов: подписанный индекс канала и заглушка installer.
 * Сборка deb не исполняет installer и не требует сети.
 */
async function artifactsFixture(t, channel = 'release') {
  const fixture = signedIndex({ channel });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deb-artifacts-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, `${channel}.json`),
    JSON.stringify(fixture.index) + '\n', { mode: 0o644 });
  await fs.writeFile(path.join(directory, 'grigdesk-install'),
    '#!/bin/sh\n: заглушка installer\n', { mode: 0o755 });

  return { fixture, directory };
}

test('DEB-1: сборка пакета с версией и зависимостью из подписанного индекса', async (t) => {
  if (!hasDpkg) {
    t.skip('dpkg-deb недоступен');

    return;
  }

  const { fixture, directory } = await artifactsFixture(t);
  const deb = await buildDeb({ root: repository(), artifacts: directory });
  const { stdout: fields } = await execute('dpkg-deb', ['-f', deb,
    'Package', 'Version', 'Architecture', 'Depends']);

  assert.match(path.basename(deb), /^grigdesk_[0-9.]+(-dev\.[0-9]+)?_amd64\.deb$/u);
  assert.match(fields, /Package: grigdesk/);
  assert.match(fields, new RegExp(`Version: ${fixture.index.latest.payload.version}`));
  assert.match(fields, /Architecture: amd64/);
  assert.match(fields, new RegExp(`Depends: libc6 \\(>= ${fixture.index.latest.payload.platform.glibc}\\)`));
});

test('DEB-2: бутстрап ставит комплект в пределах пользователя и передаёт управление', async (t) => {
  if (!hasDpkg) {
    t.skip('dpkg-deb недоступен');

    return;
  }

  const { directory } = await artifactsFixture(t, 'dev');
  const deb = await buildDeb({ root: repository(), artifacts: directory });
  const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'deb-tree-'));

  t.after(() => fs.rm(tree, { recursive: true, force: true }));
  await execute('dpkg-deb', ['-x', deb, tree]);

  const bootstrap = await fs.readFile(path.join(tree, 'usr/bin/grigdesk'), 'utf8');

  assert.match(bootstrap, /grigdesk-install install local/);
  assert.match(bootstrap, /exec "\$HOME\/\.local\/bin\/grigdesk" "\$@"/);
  assert.match(bootstrap, /current\.json/);

  const installed = await fs.readFile(path.join(tree, 'usr/lib/grigdesk/grigdesk-install'), 'utf8');

  assert.match(installed, /заглушка/);

  const desktop = await fs.readFile(path.join(tree, 'usr/share/applications/grigdesk.desktop'), 'utf8');

  assert.match(desktop, /Exec=\/usr\/bin\/grigdesk/);
});

test('DEB-3: без индекса канала сборка отказывает', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deb-empty-'));

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(buildDeb({ root: repository(), artifacts: directory }),
    /deb_release_index_missing/);
});

function repository() {
  return path.resolve(import.meta.dirname, '../..');
}
