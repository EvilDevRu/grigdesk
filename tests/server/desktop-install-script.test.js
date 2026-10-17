import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { desktopRuntimePath, parseRuntimeDescriptor } from '../../shared/desktop/desktopRuntime.ts';

const repository = fileURLToPath(new URL('../..', import.meta.url));

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Копии CLI, manifest и фальшивого AppImage находятся только под своим root.
 * PATH содержит собственные команды, HOME/XDG — собственные каталоги с пробелами.
 */
function sandbox(t, { build = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-desktop-install-'));
  const repo = path.join(root, 'копия проекта');
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'команды');
  const nodeDir = path.join(root, 'Node каталог');
  const data = path.join(home, 'данные XDG');
  const destination = path.join(data, 'cockpit/desktop/cockpit-desktop.AppImage');
  const runtime = path.join(data, 'cockpit/desktop/runtime.json');
  const source = path.join(repo, 'desktop/release/cockpit-desktop-9.9.9-x86_64.AppImage');

  t.after(() => rmSync(root, {
    recursive: true,
    force: true,
  }));

  for (const directory of [home, fakeBin, nodeDir, path.dirname(source), path.join(repo, 'deploy/lib')]) {
    mkdirSync(directory, { recursive: true });
  }

  for (const name of ['deploy/desktop.sh', 'deploy/lib/desktop-app.sh', 'deploy/lib/runtime-env.sh']) {
    copyFileSync(path.join(repository, name), path.join(repo, name));
  }

  for (const name of ['dirname', 'mkdir', 'mktemp', 'cp', 'chmod', 'mv', 'rm']) {
    symlinkSync('/usr/bin/' + name, path.join(fakeBin, name));
  }

  writeFileSync(path.join(nodeDir, 'node'), `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(path.join(repo, 'desktop/package.json'), JSON.stringify({ version: '9.9.9' }));
  writeFileSync(path.join(repo, '.env'), 'COCKPIT_PORT=не_нужен_установке\n');

  if (build) {
    writeFileSync(source, 'сборка 9.9.9', { mode: 0o644 });
  }

  const env = {
    PATH: fakeBin,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    COCKPIT_NODE_DIR: nodeDir,
  };
  const runVia = (script, action, overrides = {}) => spawnSync('/bin/bash', [script, action], {
    env: {
      ...env,
      ...overrides,
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  const run = (action, overrides = {}) => runVia(path.join(repo, 'deploy/desktop.sh'), action, overrides);

  return {
    root,
    repo,
    home,
    fakeBin,
    nodeDir,
    source,
    destination,
    runtime,
    run,
    runVia,
  };
}

function status(box, overrides = {}) {
  const response = box.run('status', overrides);

  assert.equal(response.status, 0, response.stderr);

  return Object.fromEntries(response.stdout.trim().split('\n').map((line) => line.split('\t')));
}

/**
 * Старое окно создаётся только в sandbox, без ссылки на реальную установку.
 * После ошибки установки его байты и режим должны оставаться прежними.
 */
function previousInstallation(box) {
  mkdirSync(path.dirname(box.destination), { recursive: true });
  writeFileSync(box.destination, 'прежнее окно', { mode: 0o755 });
}

test('DW-I1: install и status', (t) => {
  const box = sandbox(t);
  const installed = box.run('install');

  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(existsSync(box.destination), true);
  assert.equal(readFileSync(box.destination, 'utf8'), 'сборка 9.9.9');
  assert.equal(statSync(box.destination).mode & 0o777, 0o755);
  assert.deepEqual(status(box), {
    installed: '1',
    path: box.destination,
    runtime: '1',
  });
});

test('DW-I2: нет сборки — установка сохранена', (t) => {
  const box = sandbox(t, { build: false });
  const absent = box.run('install');

  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /npm --prefix desktop run dist/u);
  assert.equal(existsSync(box.destination), false);
  previousInstallation(box);

  const preserved = box.run('install');

  assert.equal(preserved.status, 1);
  assert.equal(readFileSync(box.destination, 'utf8'), 'прежнее окно');
});

test('DW-I3: повторная установка заменяет атомарно', (t) => {
  const box = sandbox(t);

  previousInstallation(box);

  const oldReader = openSync(box.destination, 'r');

  try {
    assert.equal(box.run('install').status, 0);
    assert.equal(readFileSync(box.destination, 'utf8'), 'сборка 9.9.9');
    assert.equal(readFileSync(oldReader, 'utf8'), 'прежнее окно');
  } finally {
    closeSync(oldReader);
  }

  writeFileSync(box.source, 'новая сборка');
  assert.equal(box.run('install').status, 0);
  assert.equal(readFileSync(box.destination, 'utf8'), 'новая сборка');
  // data-home — метка сборки, знающей папку данных: без неё перенос не уберёт ссылки.
  assert.deepEqual(readdirSync(path.dirname(box.destination)).sort(),
    ['cockpit-desktop.AppImage', 'data-home', 'runtime.json']);
  assert.equal(box.run('remove').status, 0);
  assert.equal(existsSync(path.join(path.dirname(box.destination), 'data-home')), false);
});

test('DW-I4: remove не трогает профиль', (t) => {
  const box = sandbox(t);
  const profile = path.join(box.home, 'config/Кокпит/settings.json');

  previousInstallation(box);
  mkdirSync(path.dirname(profile), { recursive: true });
  writeFileSync(profile, 'сентинел профиля');
  assert.equal(box.run('remove').status, 0);
  assert.equal(existsSync(box.destination), false);
  assert.equal(readFileSync(profile, 'utf8'), 'сентинел профиля');
  assert.equal(box.run('remove').status, 0);
});

test('DW-I5: неизвестная команда без Node', (t) => {
  const box = sandbox(t);
  const result = box.run('unknown', { COCKPIT_NODE_DIR: '' });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /install\|remove\|status/u);
});

test('DW-I6: отказ cp, chmod или mv сохраняет старый файл', (t) => {
  for (const command of ['cp', 'chmod', 'mv']) {
    const box = sandbox(t);

    previousInstallation(box);
    rmSync(path.join(box.fakeBin, command));
    writeFileSync(path.join(box.fakeBin, command), '#!/bin/bash\nexit 17\n', { mode: 0o755 });

    const response = box.run('install');

    assert.notEqual(response.status, 0, command);
    assert.equal(readFileSync(box.destination, 'utf8'), 'прежнее окно');
    assert.equal(statSync(box.destination).mode & 0o777, 0o755);
    // runtime.json пишется раньше AppImage (Р9): при отказе cp он новый, временных файлов нет.
    assert.deepEqual(readdirSync(path.dirname(box.destination)).filter((name) => name !== 'runtime.json'),
      ['cockpit-desktop.AppImage']);
  }
});

test('DW-I7: Node найден явно, XDG и fallback работают', (t) => {
  const box = sandbox(t);
  const fallback = path.join(box.home, '.local/share/cockpit/desktop/cockpit-desktop.AppImage');

  assert.equal(box.run('install').status, 0);
  assert.equal(box.run('install', { COCKPIT_NODE_DIR: '' }).status, 1);
  assert.equal(readFileSync(box.destination, 'utf8'), 'сборка 9.9.9');
  assert.equal(status(box, { COCKPIT_NODE_DIR: '' }).installed, '1');
  assert.equal(box.run('remove', { COCKPIT_NODE_DIR: '' }).status, 0);
  assert.equal(status(box, {
    COCKPIT_NODE_DIR: '',
    XDG_DATA_HOME: '',
  }).path, fallback);
  assert.equal(box.run('install', { XDG_DATA_HOME: '' }).status, 0);
  assert.equal(existsSync(fallback), true);
  assert.equal(box.run('remove', {
    COCKPIT_NODE_DIR: '',
    XDG_DATA_HOME: '',
  }).status, 0);
  assert.equal(existsSync(fallback), false);
});

/**
 * mv пишет назначение в журнал и выполняет настоящий перенос. По журналу видно, что
 * описание установки фиксируется раньше, чем заменяется AppImage.
 */
function recordMoves(box) {
  const log = path.join(box.root, 'mv.log');

  rmSync(path.join(box.fakeBin, 'mv'));
  writeFileSync(path.join(box.fakeBin, 'mv'), [
    '#!/bin/bash',
    `printf '%s\\n' "\${@: -1}" >> ${shellQuote(log)}`,
    'exec /usr/bin/mv "$@"',
    '',
  ].join('\n'), { mode: 0o755 });

  return () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

/**
 * Команда отказывает только на шаге runtime.json, остальные её вызовы настоящие. Так
 * проверяется сбой записи описания, а не замены AppImage.
 */
function failOnRuntime(box, command) {
  rmSync(path.join(box.fakeBin, command));
  writeFileSync(path.join(box.fakeBin, command), [
    '#!/bin/bash',
    'case "$*" in',
    '  *runtime.json*) exit 17 ;;',
    'esac',
    `exec /usr/bin/${command} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

test('SC-01 install пишет runtime.json (version 1, pwd -P, execPath, 0600), затем AppImage', (t) => {
  const box = sandbox(t);
  const link = path.join(box.root, 'ссылка на копию');
  const moves = recordMoves(box);

  symlinkSync(box.repo, link);

  const installed = box.runVia(path.join(link, 'deploy/desktop.sh'), 'install');

  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(existsSync(box.runtime), true, 'install записал описание установки');

  const text = readFileSync(box.runtime, 'utf8');
  const expected = {
    version: 1,
    root: realpathSync(box.repo),
    node: process.execPath,
  };

  assert.deepEqual(JSON.parse(text), expected);
  assert.deepEqual(parseRuntimeDescriptor(text), expected);
  assert.equal(statSync(box.runtime).mode & 0o777, 0o600);
  assert.deepEqual(moves(), [box.runtime, box.destination]);
  assert.equal(readFileSync(box.destination, 'utf8'), 'сборка 9.9.9');
});

test('SC-02 сбой записи descriptor — AppImage и прежний descriptor не тронуты, код не 0', (t) => {
  const previous = JSON.stringify({
    version: 1,
    root: '/прежний корень',
    node: '/прежний/node',
  });

  for (const command of ['mktemp', 'chmod', 'mv']) {
    const box = sandbox(t);

    previousInstallation(box);
    writeFileSync(box.runtime, previous, { mode: 0o600 });
    failOnRuntime(box, command);

    const response = box.run('install');

    assert.notEqual(response.status, 0, command);
    assert.equal(readFileSync(box.destination, 'utf8'), 'прежнее окно', command);
    assert.equal(statSync(box.destination).mode & 0o777, 0o755, command);
    assert.equal(readFileSync(box.runtime, 'utf8'), previous, command);
    assert.equal(statSync(box.runtime).mode & 0o777, 0o600, command);
    assert.deepEqual(readdirSync(path.dirname(box.destination)).sort(),
      ['cockpit-desktop.AppImage', 'runtime.json'], command);
  }
});

test('SC-03 status: строка runtime 0 и 1; remove удаляет AppImage и descriptor, профиль цел', (t) => {
  const box = sandbox(t);
  const profile = path.join(box.home, 'config/Кокпит/settings.json');
  const withoutNode = { COCKPIT_NODE_DIR: '' };

  assert.deepEqual(status(box, withoutNode), {
    installed: '0',
    path: box.destination,
    runtime: '0',
  });
  assert.equal(box.run('install').status, 0);
  assert.deepEqual(status(box, withoutNode), {
    installed: '1',
    path: box.destination,
    runtime: '1',
  });

  mkdirSync(path.dirname(profile), { recursive: true });
  writeFileSync(profile, 'сентинел профиля');

  const removed = box.run('remove', withoutNode);

  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(box.destination), false);
  assert.equal(existsSync(box.runtime), false);
  assert.equal(readFileSync(profile, 'utf8'), 'сентинел профиля');
  assert.equal(status(box, withoutNode).runtime, '0');
});

test('SC-04 путь в bash равен desktopRuntimePath для пустого, относительного и абсолютного XDG', (t) => {
  const box = sandbox(t);
  const library = path.join(box.repo, 'deploy/lib/desktop-app.sh');
  const script = 'set -euo pipefail; source "$1"; cockpit_desktop_runtime_path';

  for (const dataHome of [undefined, '', 'относительный каталог/данные', path.join(box.home, 'данные XDG')]) {
    const env = {
      PATH: box.fakeBin,
      HOME: box.home,
    };

    if (dataHome !== undefined) {
      env.XDG_DATA_HOME = dataHome;
    }

    const result = spawnSync('/bin/bash', ['-c', script, '_', library], {
      env,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.stdout, desktopRuntimePath({
      env,
      home: box.home,
    }) + '\n', `XDG_DATA_HOME=${dataHome}: ${result.stderr}`);
    assert.equal(result.status, 0, result.stderr);
  }
});

/**
 * Установщик исполняется в копии с отдельным HOME и заглушками системных команд.
 * Проверяем итоговую инструкцию без сборок, настоящего systemd и установки пользователя.
 * С port — настоящий Node и runtime-env.sh: порт приходит через COCKPIT_PORT, как у человека.
 */
function serverInstaller(t, {
  autostart = 0,
  port = null,
  explicit = false,
  unitOnly = false,
  previousLink = null,
  b24Fails = false,
  foreignB24 = false,
  codeName = 'code',
  homeName = 'home',
} = {}) {
  const container = mkdtempSync(path.join(os.tmpdir(), 'cockpit-server-install-text-'));
  const root = path.join(container, codeName);
  const fakeBin = path.join(container, 'commands');
  const home = path.join(container, homeName);
  const dataHome = explicit ? path.join(container, 'data') : path.join(home, '.cockpit');
  const systemctlLog = path.join(container, 'systemctl.log');
  const otherLog = path.join(container, 'other.log');

  t.after(() => rmSync(container, { recursive: true, force: true }));

  for (const directory of [fakeBin, home, path.join(root, 'web'), path.join(root, 'bin'),
    path.join(root, 'b24')]) {
    mkdirSync(directory, { recursive: true });
  }

  for (const file of ['deploy/install.sh', 'deploy/cockpit-server.service', 'deploy/lib/b24-cli.sh',
    'deploy/lib/install-choices.sh', 'deploy/lib/runtime-env.sh', 'shared/runtime/dataHome.ts',
    'shared/package.json', 'server/scripts/dataHomeCheck.mts', 'server/src/lib/dataHomeBoot.ts']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(repository, file), path.join(root, file));
  }

  writeFileSync(path.join(root, 'deploy/lib/media-runtime.sh'),
    `cockpit_install_media() { echo speech >> ${shellQuote(otherLog)}; }\n`);
  writeFileSync(path.join(root, 'deploy/lib/cli-link.sh'), 'cockpit_link_cli() { :; }\n');
  writeFileSync(path.join(fakeBin, 'systemctl'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(systemctlLog)}\nexit 0\n`, { mode: 0o755 });

  writeFileSync(path.join(fakeBin, 'loginctl'),
    `#!/bin/bash\necho loginctl >> ${shellQuote(otherLog)}\nexit 0\n`, { mode: 0o755 });
  // npm пишет полный argv; сборка b24 создаёт исполняемый результат, который проверяет helper.
  writeFileSync(path.join(fakeBin, 'npm'), [
    '#!/bin/bash',
    `printf 'npm %s\\n' "$*" >> ${shellQuote(otherLog)}`,
    'if [[ "$1" == --prefix && "$2" == */b24 && "$3" == run && "$4" == build ]]; then',
    b24Fails ? '  exit 4' : '  :',
    '  printf \'#!/bin/sh\\n\' > "$2/../bin/b24"',
    '  chmod 755 "$2/../bin/b24"',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  if (previousLink) {
    mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    symlinkSync(previousLink, path.join(home, '.local/bin/b24'));
  }

  if (foreignB24) {
    mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    writeFileSync(path.join(home, '.local/bin/b24'), '#!/bin/sh\n', { mode: 0o755 });
  }

  const skipProbe = port === null ? '[[ "$*" == *"fetch("* ]] && exit 0\n' : '';

  writeFileSync(path.join(fakeBin, 'node'),
    `#!/bin/bash\n${skipProbe}exec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });

  const result = spawnSync('/bin/bash', [path.join(root, 'deploy/install.sh'),
    ...(unitOnly ? ['--unit-only'] : [autostart ? '--autostart' : '--no-autostart', '--no-shortcut'])], {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'data'),
      PATH: fakeBin + ':/usr/bin:/bin',
      ...(explicit ? { COCKPIT_HOME: dataHome } : {}),
      ...(port === null ? {} : { COCKPIT_PORT: String(port) }),
    },
    encoding: 'utf8',
    timeout: 10000,
  });

  return {
    ...result,
    root,
    home,
    dataHome,
    unit: path.join(home, '.config/systemd/user/cockpit-server.service'),
    others: existsSync(otherLog) ? readFileSync(otherLog, 'utf8') : '',
    systemctl: existsSync(systemctlLog) ? readFileSync(systemctlLog, 'utf8').trim().split('\n') : [],
  };
}

test('DW-I9: установка сервера объясняет запуск окна и вход по ключу', (t) => {
  const result = serverInstaller(t);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cockpit desktop install/u);
  assert.match(result.stdout, /cockpit open/u);
  assert.match(result.stdout, /локальному ключу/u);
  assert.doesNotMatch(result.stdout, /парол|открой.*https?:|браузер/iu);
});

// HTTP-заглушка живёт в отдельном процессе: spawnSync установщика блокирует цикл событий
// теста, и сервер в самом тесте не ответил бы на проверку порта.
const PORT_STUB = `
const http = require('node:http');
const kind = process.argv[1];
const server = http.createServer((request, response) => {
  if (kind === 'cockpit' && request.url === '/api/auth/state') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ configured: true, authenticated: false }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));
`;

/**
 * Заглушка на свободном порту: 'cockpit' отвечает схемой auth/state, 'other' — 404 на всё.
 * Возвращает порт; процесс убирается после теста.
 */
function portStub(t, kind) {
  const child = spawn(process.execPath, ['-e', PORT_STUB, kind], { stdio: ['ignore', 'pipe', 'inherit'] });

  t.after(() => child.kill('SIGKILL'));

  return new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`заглушка порта вышла с кодом ${code}`)));
  });
}

/**
 * Свободный порт без слушателя: занять его и сразу освободить.
 * Проверка установщика на нём получает отказ соединения.
 */
async function closedPort() {
  const server = createServer();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address();

  await new Promise((resolve) => server.close(resolve));

  return port;
}

test('SC-08 порт отвечает Кокпитом — start и enable --now не вызываются; иначе прежний старт', async (t) => {
  const port = await portStub(t, 'cockpit');
  const notice = `Кокпит уже работает на порту ${port} — юнит не запускаю`;
  const starts = (calls) => calls.filter((call) => /(^|\s)(start|--now)(\s|$)/u.test(call));

  for (const autostart of [0, 1]) {
    const result = serverInstaller(t, {
      autostart,
      port,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(starts(result.systemctl), [], result.systemctl.join('\n'));
    assert.ok(result.stdout.includes(notice), result.stdout);
    assert.equal(result.systemctl.includes('--user enable cockpit-server.service'), autostart === 1);
  }

  for (const free of [await closedPort(), await portStub(t, 'other')]) {
    const manual = serverInstaller(t, { port: free });
    const automatic = serverInstaller(t, {
      autostart: 1,
      port: free,
    });

    assert.equal(manual.status, 0, manual.stderr);
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.deepEqual(starts(manual.systemctl), ['--user start cockpit-server.service']);
    assert.deepEqual(starts(automatic.systemctl), ['--user enable --now cockpit-server.service']);
    assert.doesNotMatch(manual.stdout + automatic.stdout, /уже работает/u);
  }
});


test('INS-DH-1/2 шаблон юнита получает env и только явный COCKPIT_HOME', (t) => {
  for (const explicit of [false, true]) {
    const result = serverInstaller(t, { explicit });

    assert.equal(result.status, 0, result.stderr);

    const unit = readFileSync(result.unit, 'utf8');

    assert.ok(unit.includes(`EnvironmentFile=-${result.dataHome}/.env`));
    assert.match(unit, /RestartPreventExitStatus=78/);
    assert.equal(unit.includes(`Environment=COCKPIT_HOME=${result.dataHome}`), explicit);
    assert.equal(statSync(result.dataHome).mode & 0o777, 0o700);
  }
});

test('BL-05: --unit-only обходит сборку и ссылку', (t) => {
  const previous = '/previous/b24';
  const result = serverInstaller(t, {
    unitOnly: true,
    previousLink: previous,
  });
  const full = serverInstaller(t);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.others, /b24/);
  assert.equal(readlinkSync(path.join(result.home, '.local/bin/b24')), previous);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.others, /npm --prefix \S+\/b24 ci --include=dev --no-audit --no-fund\n/);
  assert.match(full.others, /npm --prefix \S+\/b24 run build\n/);
  assert.ok(readlinkSync(path.join(full.home, '.local/bin/b24')).endsWith('/code/bin/b24'));
});

test('BL-09: отказ сборки b24 предупреждает, но установку сервера не прерывает', (t) => {
  for (const suffix of ['', ' с пробелами']) {
    const result = serverInstaller(t, {
      b24Fails: true,
      explicit: true,
      codeName: `code${suffix}`,
      homeName: `home${suffix}`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /b24 не собран; повтор: bash /);

    const retry = result.stderr.match(/b24 не собран; повтор: (.+)/)?.[1];
    const parsed = spawnSync('/bin/bash', ['-c', `set -- ${retry}; printf '%s\\0' "$@"`], {
      cwd: os.tmpdir(),
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(parsed.status, 0, parsed.stderr);
    assert.deepEqual(parsed.stdout.split('\0').slice(0, -1), [
      'bash',
      path.join(result.root, 'deploy/lib/b24-cli.sh'),
      result.root,
      path.join(result.home, '.local/bin'),
    ]);
    assert.match(result.others, /speech/);
    assert.equal(existsSync(path.join(result.home, '.local/bin/b24')), false);
  }
});

test('BL-10: чужой файл b24 в PATH не выдаётся за неудачную сборку', (t) => {
  const result = serverInstaller(t, { foreignB24: true });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /не перезаписан/);
  assert.doesNotMatch(result.stderr, /b24 не собран/);
});

test('INS-DH-3 unit-only не собирает, не ставит речь и не меняет автозапуск', (t) => {
  const result = serverInstaller(t, { unitOnly: true });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(result.unit));
  assert.deepEqual(result.systemctl, ['--user daemon-reload']);
  assert.equal(result.others, '');
  assert.equal(existsSync(result.dataHome), false);
});


test('SC-DH-2 явная папка пишется в версии 2 после замены AppImage', (t) => {
  const box = sandbox(t);
  const moves = recordMoves(box);
  const home = path.join(box.root, 'data');
  const result = box.run('install', { COCKPIT_HOME: home });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(box.runtime, 'utf8')), {
    version: 2,
    root: realpathSync(box.repo),
    node: process.execPath,
    home,
  });
  assert.deepEqual(moves(), [box.destination, box.runtime]);
});

test('SC-DH-3 неверная папка не меняет прежнее описание', (t) => {
  const box = sandbox(t);

  assert.equal(box.run('install').status, 0);

  const previous = readFileSync(box.runtime, 'utf8');
  const result = box.run('install', { COCKPIT_HOME: 'relative' });

  assert.equal(result.status, 1);
  assert.equal(readFileSync(box.runtime, 'utf8'), previous);
});
