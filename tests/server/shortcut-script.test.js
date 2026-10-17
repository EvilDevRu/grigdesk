import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'deploy', 'shortcut.sh');

// Песочница: свой HOME, рабочий стол с пробелом и кириллицей (как у русской локали) и
// фальшивые xdg-user-dir/gio/update-desktop-database, которые лишь пишут журнал вызовов.
function sandbox(t, { desktop = true, data = path.join('.local', 'share') } = {}) {
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

  const dataHome = path.join(home, data);
  const env = {
    ...process.env,
    HOME: home,
    COCKPIT_HOME: path.join(home, '.cockpit'),
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const run = (action, overrides = {}) => spawnSync('bash', [script, action], {
    encoding: 'utf8',
    env: {
      ...env,
      ...overrides,
    },
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const appsFile = path.join(dataHome, 'applications', 'cockpit.desktop');

  return {
    home,
    desktopDir,
    dataHome,
    fakeBin,
    run,
    calls,
    appsFile,
  };
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

test('содержимое .desktop: переходный open с каталогом node, иконка и имя', (t) => {
  const box = sandbox(t);
  assert.equal(box.run('install').status, 0);

  const entry = readFileSync(path.join(box.desktopDir, 'cockpit.desktop'), 'utf8');
  const nodeDir = path.dirname(execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim());
  const icon = path.join(root, 'bin', 'cockpit.png');

  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Name=Кокпит$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.ok(entry.includes(`Exec=/usr/bin/env "COCKPIT_NODE_DIR=${nodeDir}" "${script}" open`), entry);
  assert.ok(entry.includes(`Icon=${icon}`));
  assert.ok(existsSync(icon), 'иконка ярлыка лежит в репозитории');
  assert.ok(statSync(script).mode & 0o111, 'скрипт ярлыка исполняемый: Exec зовёт его напрямую');
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
  assert.match(result.stderr, /install\|remove\|status\|open/);
});

test('DW-S1: Comment без браузера', (t) => {
  const box = sandbox(t);

  assert.equal(box.run('install').status, 0);

  const entry = readFileSync(box.appsFile, 'utf8');
  const nodeDir = path.dirname(execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim());

  assert.match(entry, /^Comment=Открыть кокпит; спящий сервер поднимется сам$/mu);
  assert.match(entry, /^Comment\[en\]=Open the cockpit; a stopped server is started first$/mu);
  assert.ok(entry.includes(`Exec=/usr/bin/env "COCKPIT_NODE_DIR=${nodeDir}" "${script}" open`));
});

test('ярлык ведёт в приложение без браузерного пути лаунчера', () => {
  const source = readFileSync(script, 'utf8');

  assert.doesNotMatch(source, /xdg-open|open_browser|sensible-browser|gio open/u);
  assert.match(source, /cockpit" open/u);
});

const nodeDir = path.dirname(execFileSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).trim());
const legacyExec = `Exec=/usr/bin/env "COCKPIT_NODE_DIR=${nodeDir}" "${script}" open`;
const execLine = (entry) => entry.split('\n').find((line) => line.startsWith('Exec='));

/**
 * Новое окно в песочнице: AppImage (исполняемый или нет) и его runtime.json. Ничего не
 * запускается — ярлык только ссылается на путь установленного файла.
 */
function installWindow(box, { app = true, executable = true, runtime = true } = {}) {
  const directory = path.join(box.dataHome, 'cockpit/desktop');
  const appImage = path.join(directory, 'cockpit-desktop.AppImage');

  mkdirSync(directory, { recursive: true });

  if (app) {
    writeFileSync(appImage, '#!/bin/sh\nexit 0\n', { mode: executable ? 0o755 : 0o644 });
  }

  if (runtime) {
    writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({
      version: 1,
      root,
      node: process.execPath,
    }), { mode: 0o600 });
  }

  return appImage;
}

/**
 * PATH из заглушек песочницы и ссылок только на утилиты скрипта. До запуска проверено,
 * что node в нём не находится: ярлык на новое окно не должен от него зависеть.
 */
function pathWithoutNode(box) {
  const tools = path.join(box.home, 'утилиты без node');

  mkdirSync(tools, { recursive: true });

  for (const name of ['bash', 'cat', 'chmod', 'dirname', 'mkdir', 'rm', 'sed', 'tail']) {
    const file = ['/usr/bin', '/bin'].map((directory) => path.join(directory, name)).find(existsSync);

    symlinkSync(file, path.join(tools, name));
  }

  const PATH = `${box.fakeBin}:${tools}`;
  const probe = spawnSync('/bin/bash', ['-c', 'command -v node'], { env: { PATH } });

  assert.notEqual(probe.status, 0, 'в PATH без node нашёлся node');

  return PATH;
}

test('SC-05 есть AppImage и descriptor: Exec — AppImage в кавычках, пробелы и кириллица, без node', (t) => {
  const box = sandbox(t, { data: 'Данные приложений/общие файлы' });
  const app = installWindow(box);
  const desktopFile = path.join(box.desktopDir, 'cockpit.desktop');

  assert.equal(box.run('install').status, 0);
  assert.equal(execLine(readFileSync(box.appsFile, 'utf8')), `Exec="${app}"`);

  rmSync(box.appsFile);
  rmSync(desktopFile);

  const installed = box.run('install', { PATH: pathWithoutNode(box) });

  assert.equal(installed.status, 0, installed.stderr);

  const entry = readFileSync(box.appsFile, 'utf8');

  assert.equal(execLine(entry), `Exec="${app}"`);
  assert.doesNotMatch(entry, /COCKPIT_NODE_DIR|shortcut\.sh/u);
  assert.match(entry, /^Comment=Открыть кокпит; спящий сервер поднимется сам$/mu);
  assert.equal(readFileSync(desktopFile, 'utf8'), entry, 'меню и рабочий стол — одна запись');
  assert.ok(statSync(desktopFile).mode & 0o111, 'ярлык на рабочем столе исполняемый');
});

test('SC-06 нет descriptor: переходный Exec на shortcut.sh open', (t) => {
  // Без runtime.json, без AppImage и с неисполняемым AppImage новое окно не считается установленным.
  for (const window of [{ runtime: false }, { app: false }, { executable: false }]) {
    const box = sandbox(t);

    installWindow(box, window);

    const installed = box.run('install');

    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(execLine(readFileSync(box.appsFile, 'utf8')), legacyExec, JSON.stringify(window));
  }
});

test('SC-07 повторная установка заменяет ярлык; remove как раньше', (t) => {
  const box = sandbox(t);
  const desktopFile = path.join(box.desktopDir, 'cockpit.desktop');

  assert.equal(box.run('install').status, 0);
  assert.equal(execLine(readFileSync(desktopFile, 'utf8')), legacyExec);

  const app = installWindow(box);

  assert.equal(box.run('install').status, 0);

  for (const file of [desktopFile, box.appsFile]) {
    assert.equal(execLine(readFileSync(file, 'utf8')), `Exec="${app}"`, file);
  }

  // Окно удалено (cockpit desktop remove): повторная установка возвращает переходный путь.
  rmSync(path.dirname(app), {
    recursive: true,
    force: true,
  });
  assert.equal(box.run('install').status, 0);
  assert.equal(execLine(readFileSync(box.appsFile, 'utf8')), legacyExec);

  const removed = box.run('remove');

  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!existsSync(desktopFile));
  assert.ok(!existsSync(box.appsFile));
  assert.deepEqual(parseStatus(box.run('status').stdout), {
    desktop_dir: box.desktopDir,
    desktop: '0',
    menu: '0',
  });
});
