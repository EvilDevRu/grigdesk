import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'deploy', 'shortcut.sh');

// Песочница: свой HOME, рабочий стол с пробелом и кириллицей (как у русской локали) и
// фальшивые xdg-user-dir/gio/update-desktop-database, которые лишь пишут журнал вызовов.
function sandbox(t, { desktop = true } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cockpit-shortcut-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const desktopDir = path.join(home, 'Рабочий стол');
  const fakeBin = path.join(home, 'fake-bin');
  const log = path.join(home, 'calls.log');
  mkdirSync(fakeBin, { recursive: true });
  if (desktop) mkdirSync(desktopDir, { recursive: true });
  const fake = (name, body) => {
    const text = `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`;

    writeFileSync(path.join(fakeBin, name), text, { mode: 0o755 });
  };
  fake('xdg-user-dir', `[ "$1" = DESKTOP ] && printf '%s\\n' "${desktop ? desktopDir : home}"`);
  fake('gio', '');
  fake('update-desktop-database', '');
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const run = (action) => spawnSync('bash', [script, action], { encoding: 'utf8', env });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const appsFile = path.join(home, '.local', 'share', 'applications', 'cockpit.desktop');

  return { home, desktopDir, run, calls, appsFile };
}

// Строки status → объект, как их читает сервер.
function parseStatus(stdout) {
  return Object.fromEntries(stdout.trim().split('\n').map((line) => line.split('\t')));
}

test('install кладёт ярлык на рабочий стол и в меню, status это видит, remove убирает', (t) => {
  const box = sandbox(t);

  assert.deepEqual(parseStatus(box.run('status').stdout),
    { desktop_dir: box.desktopDir, desktop: '0', menu: '0' });

  const installed = box.run('install');
  assert.equal(installed.status, 0, installed.stderr);
  const desktopFile = path.join(box.desktopDir, 'cockpit.desktop');
  assert.ok(existsSync(desktopFile));
  assert.ok(existsSync(box.appsFile));
  assert.ok(statSync(desktopFile).mode & 0o111, 'ярлык на рабочем столе исполняемый');
  assert.deepEqual(parseStatus(box.run('status').stdout),
    { desktop_dir: box.desktopDir, desktop: '1', menu: '1' });
  assert.ok(box.calls().some((call) => call.startsWith(`gio set ${desktopFile} metadata::trusted true`)),
    'GNOME пускает ярлык только доверенным');
  assert.ok(box.calls().some((call) => call.startsWith('update-desktop-database ')));

  assert.equal(box.run('install').status, 0, 'повторная установка идемпотентна');

  const removed = box.run('remove');
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!existsSync(desktopFile));
  assert.ok(!existsSync(box.appsFile));
  assert.deepEqual(parseStatus(box.run('status').stdout),
    { desktop_dir: box.desktopDir, desktop: '0', menu: '0' });
});

test('содержимое .desktop: запуск bin/launch с каталогом node, иконка и имя', (t) => {
  const box = sandbox(t);
  assert.equal(box.run('install').status, 0);

  const entry = readFileSync(path.join(box.desktopDir, 'cockpit.desktop'), 'utf8');
  const nodeDir = path.dirname(execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim());
  const launcher = path.join(root, 'bin', 'launch');
  const icon = path.join(root, 'web', 'public', 'icon-512.png');

  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Name=Кокпит$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.ok(entry.includes(`Exec=/usr/bin/env "COCKPIT_NODE_DIR=${nodeDir}" "${launcher}"`), entry);
  assert.ok(entry.includes(`Icon=${icon}`));
  assert.ok(existsSync(icon), 'иконка ярлыка лежит в репозитории');
  assert.ok(existsSync(launcher) && (statSync(launcher).mode & 0o111), 'лаунчер исполняемый');
  assert.equal(readFileSync(box.appsFile, 'utf8'), entry, 'меню и рабочий стол — одна запись');
});

test('без каталога рабочего стола install отказывает, а status и remove работают', (t) => {
  const box = sandbox(t, { desktop: false });

  const status = parseStatus(box.run('status').stdout);
  assert.equal(status.desktop, '0');
  assert.equal(status.desktop_dir, '', 'ответ xdg-user-dir «сам HOME» — не рабочий стол');

  const installed = box.run('install');
  assert.notEqual(installed.status, 0);
  assert.match(installed.stderr, /рабочего стола/);
  assert.ok(!existsSync(box.appsFile), 'половинчатой установки в меню нет');
  assert.equal(box.run('remove').status, 0);
});

test('неизвестное действие — код 2 и подсказка', (t) => {
  const box = sandbox(t);
  const result = box.run('frobnicate');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /install\|remove\|status/);
});
