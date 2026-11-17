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

test('DEB-ONLINE: прежний ELF нельзя упаковать как лёгкий загрузчик', async (t) => {
  const { directory } = await artifactsFixture(t);
  const binary = Buffer.alloc(128 * 1024, 0);

  binary.set([0x7f, 0x45, 0x4c, 0x46]);
  await fs.writeFile(path.join(directory, 'grigdesk-install'), binary);
  await assert.rejects(buildDeb({ root: repository(), artifacts: directory }),
    /deb_installer_not_script/);
});

test('DEB-BOOTSTRAP: первый запуск ставит, повтор запускает пользовательский launcher', async (t) => {
  const { directory } = await artifactsFixture(t);
  const deb = await buildDeb({ root: repository(), artifacts: directory });
  const extract = await fs.mkdtemp(path.join(os.tmpdir(), 'deb-bootstrap-'));

  t.after(() => fs.rm(extract, { recursive: true, force: true }));

  await execute('dpkg-deb', ['-x', deb, extract]);

  const original = await fs.readFile(path.join(extract, 'usr/bin/grigdesk'), 'utf8');
  const home = path.join(extract, 'home');
  const installer = path.join(extract, 'fake-grigdesk-install');
  const bootstrap = path.join(extract, 'bootstrap-test');
  const installerLog = path.join(extract, 'installer.log');
  const launcherLog = path.join(extract, 'launcher.log');
  const launcherScript = `#!/bin/sh\nprintf 'launcher %s\\n' "$*" > '${launcherLog}'\n`;
  const launcherBase64 = Buffer.from(launcherScript).toString('base64');

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(installer, [
    '#!/bin/sh',
    `printf 'installer %s\\n' "$*" > ${JSON.stringify(installerLog)}`,
    'mkdir -p "$HOME/.local/bin" "$HOME/.local/lib/grigdesk"',
    'printf \'{}\' > "$HOME/.local/lib/grigdesk/current.json"',
    `printf '%s' ${JSON.stringify(launcherBase64)} | base64 -d > "$HOME/.local/bin/grigdesk"`,
    'chmod 755 "$HOME/.local/bin/grigdesk"',
    '"$HOME/.local/bin/grigdesk"',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(bootstrap,
    original.replaceAll('/usr/lib/grigdesk/grigdesk-install', installer), { mode: 0o755 });

  const env = { ...process.env, HOME: home };

  await execute(bootstrap, [], { env });

  assert.match(await fs.readFile(installerLog, 'utf8'), /install local --launch/u);
  assert.match(await fs.readFile(launcherLog, 'utf8'), /.*/u);

  await fs.rm(installerLog, { force: true });
  await execute(bootstrap, [], { env });

  assert.ok(await fs.stat(installerLog).then(() => false, () => true));
  assert.match(await fs.readFile(launcherLog, 'utf8'), /.*/u);

  const entry = await fs.readFile(path.join(extract, 'usr/share/applications/grigdesk.desktop'),
    'utf8');

  assert.match(entry, /Terminal=true/u);

  const depends = await execute('dpkg-deb', ['--field', deb, 'Depends']);

  assert.match(depends.stdout, /curl/u);
  assert.match(depends.stdout, /gzip/u);
  assert.match(depends.stdout, /coreutils/u);
});

test('DEB-BOOTSTRAP-FAIL: отказ установщика не запускает окно', async (t) => {
  const { directory } = await artifactsFixture(t);
  const deb = await buildDeb({ root: repository(), artifacts: directory });
  const extract = await fs.mkdtemp(path.join(os.tmpdir(), 'deb-bootstrap-fail-'));

  t.after(() => fs.rm(extract, { recursive: true, force: true }));

  await execute('dpkg-deb', ['-x', deb, extract]);

  const original = await fs.readFile(path.join(extract, 'usr/bin/grigdesk'), 'utf8');
  const home = path.join(extract, 'home');
  const installer = path.join(extract, 'failing-install');
  const bootstrap = path.join(extract, 'bootstrap-test');
  const launcherLog = path.join(extract, 'launcher.log');

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(installer, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  await fs.writeFile(bootstrap,
    original.replaceAll('/usr/lib/grigdesk/grigdesk-install', installer), { mode: 0o755 });

  await assert.rejects(execute(bootstrap, [], { env: { ...process.env, HOME: home } }));
  assert.ok(await fs.stat(launcherLog).then(() => false, () => true));
});
