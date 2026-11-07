import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { insideUnit, insideWindowScope, readSettings } from '../../cli/commands.ts';
import { deriveServerState, gateReason, parseShow } from '../../cli/server.ts';
import type { UnitInfo } from '../../cli/server.ts';
import type { GrigDeskProbe } from '../../shared/runtime/grigDeskReadiness.ts';
import { parseArgs } from '../../cli/args.ts';
import { completed, createSandbox } from './helpers/sandbox.mts';

const unitName = 'grigdesk-server.service';
const startCall = `systemctl --user start --no-block ${unitName}`;
const defaultUnit: UnitInfo = {
  load: 'loaded',
  active: 'active',
  sub: 'running',
  result: 'success',
  workingDirectory: '/example/server',
};

test('CS-1 свойства show в произвольном порядке и отсутствующий ключ', () => {
  assert.deepEqual(parseShow('WorkingDirectory=\nResult=exit-code\nActiveState=failed\nLoadState=loaded'), {
    load: 'loaded',
    active: 'failed',
    sub: '',
    result: 'exit-code',
    workingDirectory: '',
  });
});

test('CS-2 все 19 строк таблицы состояний', () => {
  const cases: [Partial<UnitInfo> | null, GrigDeskProbe, string, boolean | null, string | null][] = [
    [null, 'grigdesk', 'ready', null, 'systemd недоступен — служба не проверена'],
    [null, 'refused', 'unknown', null, 'systemd недоступен'],
    [{ load: 'not-found' }, 'grigdesk', 'ready', false, 'работает вне службы'],
    [{ load: 'not-found' }, 'refused', 'not_installed', false,
      'служба не установлена: deploy/install.sh --no-autostart'],
    [{ load: 'not-found' }, 'no_answer', 'conflict', false, 'порт занят другой программой'],
    [{ load: 'masked' }, 'grigdesk', 'mismatch', null, 'служба в состоянии masked'],
    [{ workingDirectory: '/elsewhere/server' }, 'grigdesk', 'mismatch', false,
      'служба указывает на другую копию: /elsewhere/server'],
    [{}, 'grigdesk', 'ready', true, null],
    [{}, 'refused', 'starting', true, 'процесс запущен, порт ещё не открыт'],
    [{}, 'no_answer', 'not_responding', true, 'не отвечает на проверку'],
    [{}, 'other', 'conflict', true, 'порт занят другой программой'],
    [{ active: 'activating' }, 'grigdesk', 'conflict', false,
      'порт держит ручной запуск, служба не может стартовать'],
    [{ active: 'activating' }, 'refused', 'starting', true, 'ждёт VPN: нет маршрута'],
    [{ active: 'deactivating' }, 'refused', 'stopping', true, null],
    [{ active: 'inactive' }, 'grigdesk', 'ready', false, 'работает вне службы, служба остановлена'],
    [{
      active: 'failed',
      result: 'exit-code',
    }, 'refused', 'failed', true, 'служба упала: exit-code'],
    [{ active: 'inactive' }, 'refused', 'stopped', true, null],
    [{ active: 'failed' }, 'other', 'conflict', false, 'порт занят другой программой'],
    [{ active: 'strange' }, 'refused', 'unknown', null, 'неизвестное состояние strange'],
  ];

  for (const [fields, probe, state, managed, reason] of cases) {
    assert.deepEqual(deriveServerState({
      unit: fields === null ? null : {
        ...defaultUnit,
        ...fields,
      },
      probe,
      expectedDirectory: '/example/server',
      gate: 'нет маршрута',
    }), {
      state,
      managed,
      reason,
    }, `строка ${cases.findIndex((row) => row[0] === fields) + 1}`);
  }
});

test('CS-3 последняя строка VPN-ворот', () => {
  const refusal = 'VPN-ворота: нет маршрута — запуск запрещён';

  assert.equal(gateReason('обычная строка\n' + refusal), 'нет маршрута');
  assert.equal(gateReason(refusal + '\nVPN-ворота: готово — старт разрешён'), null);
  assert.equal(gateReason('нет ворот'), null);
});

test('CS-4 точный сегмент cgroup и несколько строк v1', () => {
  assert.equal(insideUnit(`0::/user.slice/${unitName}/task`, unitName), true);
  assert.equal(insideUnit('0::/app-gnome-terminal.scope', unitName), false);
  assert.equal(insideUnit(`0::/${unitName}-x`, unitName), false);
  assert.equal(insideUnit(`1:cpu:/other\n2:memory:/${unitName}`, unitName), true);
});

test('CS-4b scope окна Electron: только app-<executableName>-<pid>.scope', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../desktop/package.json', import.meta.url), 'utf8'));
  const name = manifest.build.executableName;
  const slice = '0::/user.slice/user-1000.slice/user@1000.service/app.slice';

  assert.equal(insideWindowScope(`${slice}/app-${name}-4242.scope`), true);
  assert.equal(insideWindowScope(`1:cpu:/other\n2:memory:/app.slice/app-${name}-7.scope`), true);
  assert.equal(insideWindowScope(`${slice}/app-org.gnome.Terminal.slice/vte-spawn-1f.scope`), false);
  assert.equal(insideWindowScope(`${slice}/app-${name}-4242.scope-x`), false);
  assert.equal(insideWindowScope(`${slice}/app-${name}x-4242.scope`), false);
  assert.equal(insideWindowScope(`${slice}/app-${name}-pid.scope`), false);
  assert.equal(insideWindowScope(''), false);
});

test('CS-5 настройки: приоритет env, данные файла и defaults', () => {
  assert.equal(readSettings('/example', {}, null).port, 8140);
  assert.equal(readSettings('/example', {}, 'GRIGDESK_PORT=abc').port, 8140);
  assert.equal(readSettings('/example', { GRIGDESK_PORT: '8181' }, 'GRIGDESK_PORT=8123').port, 8181);
  assert.deepEqual(readSettings('/example', { HOME: '/home/user' }, [
    'GRIGDESK_PORT=8123',
    'GRIGDESK_WINDOW_KEY_PATH=/run/test/key',
    'GRIGDESK_RELAY_PROJECT=$(printf danger)',
  ].join('\n')), {
    port: 8123,
    origin: 'http://127.0.0.1:8123',
    windowKeyPath: '/run/test/key',
    relayProject: '$(printf danger)',
    cliTokenPath: '/home/user/.grigdesk/state/cli-token',
  });
  assert.equal(readSettings('/example', { GRIGDESK_CLI_TOKEN_PATH: '/token' }, null).cliTokenPath, '/token');
});

test('CS-6 status подтверждает ready и ничего не меняет', async (t) => {
  const box = await createSandbox(t);

  box.unit({ ActiveState: 'active' });
  await box.serve('grigdesk');

  const result = await box.run(['server', 'status', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    server: {
      state: 'ready',
      managed: true,
      url: `http://127.0.0.1:${box.port}/`,
      reason: null,
    },
  });
  assert.equal(box.calls().length, 1);
  assert.match(box.calls()[0]!, /^systemctl --user show /);
});

test('CS-7 start остановленного сервера', async (t) => {
  const box = await createSandbox(t);
  const result = await box.run(['server', 'start']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Запуск сервера запрошен/);
  assert.equal(box.calls().filter((call) => call === startCall).length, 1);
});

test('CS-8 start готового сервера', async (t) => {
  const box = await createSandbox(t);

  box.unit({ ActiveState: 'active' });
  await box.serve('grigdesk');

  const result = await box.run(['server', 'start']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Сервер уже работает/);
  assert.ok(!box.calls().includes(startCall));
});

test('CS-9 сервер вне службы не останавливается и не перезапускается', async (t) => {
  const box = await createSandbox(t);

  box.unit({ LoadState: 'not-found' });
  await box.serve('grigdesk');

  const start = await box.run(['server', 'start']);

  assert.equal(start.code, 0, start.stderr);
  assert.ok(!box.calls().includes(startCall));

  for (const action of ['stop', 'restart']) {
    const result = await box.run(['server', action]);

    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(),
      'Сервер работает вне службы (приложение GrigDesk или ручной запуск); systemd им не управляет');
    assert.ok(!box.calls().includes(`systemctl --user ${action} ${unitName}`));
  }
});

test('CS-10 чужой HTTP на порту переживает отказ start', async (t) => {
  const box = await createSandbox(t);

  await box.serve('other');

  const result = await box.run(['server', 'start']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /занят другой программой/);
  assert.ok(!box.calls().includes(startCall));
  assert.equal((await fetch(`http://127.0.0.1:${box.port}/`)).status, 404);
});

test('CS-11 без юнита start и logs объясняют отказ', async (t) => {
  const box = await createSandbox(t);

  box.unit({ LoadState: 'not-found' });

  const start = await box.run(['server', 'start']);
  const logs = await box.run(['server', 'logs']);

  assert.equal(start.code, 1);
  assert.match(start.stderr, /deploy\/install.sh --no-autostart/);
  assert.equal(logs.code, 1);
  assert.match(logs.stderr, /Служба сервера не установлена/);
  assert.ok(logs.stderr.includes(path.join(box.home, '.grigdesk/state/grigdesk-server.log')));
  assert.ok(!box.calls().some((call) => call.startsWith('journalctl ')));
});

test('CS-12 чужая копия службы', async (t) => {
  const box = await createSandbox(t);

  box.unit({ WorkingDirectory: '/elsewhere/server' });

  const result = await box.run(['server', 'start']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /другую копию/);
});

test('CS-13 systemd недоступен: status успешен, start отказ', async (t) => {
  const box = await createSandbox(t);

  box.unit('unavailable');

  const status = await box.run(['server', 'status', '--json']);

  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).server.state, 'unknown');
  assert.equal((await box.run(['server', 'start'])).code, 1);
});

test('CS-14 stop и restart передаются systemd; stop остановленного идемпотентен', async (t) => {
  const box = await createSandbox(t);

  box.unit({ ActiveState: 'active' });
  await box.serve('grigdesk');

  for (const action of ['stop', 'restart']) {
    const result = await box.run(['server', action]);

    assert.equal(result.code, 0, result.stderr);
    assert.ok(box.calls().includes(`systemctl --user ${action} ${unitName}`));
    assert.match(result.stderr, /идущим ходам агентов дают закончить/);
  }

  const stopped = await createSandbox(t);
  const result = await stopped.run(['server', 'stop']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Сервер уже остановлен/);
  assert.ok(!stopped.calls().some((call) => call.includes(' stop ')));
});

test('CS-20 во время остановки stop не дублируется, start и restart передаются systemd', async (t) => {
  const box = await createSandbox(t);

  box.unit({ ActiveState: 'deactivating', SubState: 'stop-sigterm' });

  const stop = await box.run(['server', 'stop']);

  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /Сервер уже останавливается/);
  assert.ok(!box.calls().includes(`systemctl --user stop ${unitName}`));

  const start = await box.run(['server', 'start']);

  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /Запуск сервера запрошен/);
  assert.ok(box.calls().includes(startCall));

  box.unit({ ActiveState: 'deactivating', SubState: 'stop-sigterm' });

  const restart = await box.run(['server', 'restart']);

  assert.equal(restart.code, 0, restart.stderr);
  assert.ok(box.calls().includes(`systemctl --user restart ${unitName}`));
});

test('CS-15 сторож раньше внешних вызовов, force разрешает', async (t) => {
  const box = await createSandbox(t);

  writeFileSync(path.join(box.home, 'cgroup'), `0::/user.slice/${unitName}`);

  for (const action of ['stop', 'restart']) {
    const result = await box.run(['server', action]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /ход агента/);
    assert.match(result.stderr, /--force/);
  }

  assert.deepEqual(box.calls(), []);
  box.unit({ ActiveState: 'active' });
  await box.serve('grigdesk');

  assert.equal((await box.run(['server', 'stop', '--force'])).code, 0);
  assert.ok(box.calls().includes(`systemctl --user stop ${unitName}`));
});

test('CS-15b сторож видит ход агента сервера, поднятого окном', async (t) => {
  const box = await createSandbox(t);

  writeFileSync(path.join(box.home, 'cgroup'), '0::/user.slice/app.slice/app-grigdesk-4242.scope');

  for (const action of ['stop', 'restart']) {
    const result = await box.run(['server', action]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /ход агента/);
    assert.match(result.stderr, /--force/);
  }

  assert.deepEqual(box.calls(), []);
});

test('CS-16 отказ systemd передаёт stderr', async (t) => {
  const box = await createSandbox(t);

  box.fail('systemctl', 1, 'Access denied');

  const result = await box.run(['server', 'start']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Access denied/);
});

test('CS-17 wait дожидается готовности после события start', async (t) => {
  const box = await createSandbox(t);

  box.unit({}, { ActiveState: 'active' });

  const result = completed(box.spawn(['server', 'start', '--wait']));

  await box.waitFor(() => box.calls().includes(startCall));
  await box.serve('grigdesk');

  const output = await result;

  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /Сервер работает/);
});

test('CS-18 wait истёк: последнее состояние и причина VPN', async (t) => {
  const box = await createSandbox(t);

  box.unit({}, {
    ActiveState: 'activating',
    SubState: 'auto-restart',
  });
  box.journal('VPN-ворота: нет маршрута — запуск запрещён');

  const result = await box.run(['server', 'start', '--wait'], { GRIGDESK_WAIT_SEC: '2' });

  assert.equal(result.code, 3);
  assert.match(result.stderr, /не ответил за/);
  assert.match(result.stderr, /ждёт VPN/);
});

test('CS-19 logs наследует поток и возвращает код ребёнка', async (t) => {
  const box = await createSandbox(t);

  box.fail('journalctl', 4);

  const result = await box.run(['server', 'logs', '-n', '5', '-f']);

  assert.equal(result.code, 4);
  assert.ok(box.calls().includes(`journalctl --user -u ${unitName} -n 5 --no-pager -f`));
});


test('CLI-DH-1 токен вычисляется из общей папки без чтения файлов', () => {
  assert.equal(readSettings('/example', { HOME: '/home/user' }, null).cliTokenPath,
    '/home/user/.grigdesk/state/cli-token');
  assert.equal(readSettings('/example', { HOME: '/home/user', GRIGDESK_HOME: '/data/c' }, null).cliTokenPath,
    '/data/c/state/cli-token');
});

test('CLI-DH-3 файл не может переназначать общую папку', async (t) => {
  const box = await createSandbox(t);

  writeFileSync(path.join(box.home, '.grigdesk/.env'), 'GRIGDESK_HOME=/other');

  const result = await box.run(['server', 'status']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /GRIGDESK_HOME.*запрещён/);
  assert.deepEqual(box.calls(), []);
});

for (const action of ['check-updates', 'update', 'update-status', 'resume-update']) {
  test(`CLI-UPDATES: прямая команда server ${action} доступна без работающего сервера`, () => {
    const args = parseArgs(['server', action]);

    assert.equal(args.kind, 'server');
    assert.equal(args.action, action);
  });
}

test('CLI-UPDATES: явный канал dev и подтверждение restart разбираются без эффектов', () => {
  const channel = parseArgs(['server', 'update-channel', 'dev']);
  const update = parseArgs(['server', 'update', '--restart', '--force']);

  assert.equal(channel.action, 'update-channel');
  assert.equal(update.action, 'update');
  assert.equal('restart' in update && update.restart, true);
  assert.equal(update.force, true);
});

const { installedFixture, pinnedKeyHook, isolatedEnvironment } = await import(
  '../helpers/installedUpdateFixture.mjs'
);
const { loadInstalledModule } = await import('../helpers/installedBuildFixture.mjs');

 test('CLI-STOPPED: nonTTY готовит server, не запускает и не применяет без --restart', async (t) => {
  const box = await installedFixture(t, { mode: 'server' });
  const created = await box.create();
  const hook = await pinnedKeyHook(box.temporary, box.release.publicKeyPem);
  const worker = path.join(box.temporary, 'prepare.mjs');
  const nodeModule = new URL('../../shared/node/installedUpdateService.ts', import.meta.url).href;
  const stubs = path.join(box.temporary, 'stubs');

  await fs.mkdir(stubs);

  for (const component of ['desktop', 'server']) {
    const artifact = box.release.envelope.payload.artifacts[component];

    await fs.writeFile(path.join(box.temporary, `${component}.tar.gz`),
      box.release.archives.get(artifact.url));
  }

  await fs.writeFile(path.join(stubs, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await fs.writeFile(worker, [
    `import { InstalledUpdateService } from ${JSON.stringify(nodeModule)};`,
    `const service = new InstalledUpdateService(${JSON.stringify(box.root)});`,
    `import fs from 'node:fs/promises';`,
    `globalThis.fetch = async (url) => new Response(await fs.readFile(`,
    `  ${JSON.stringify(box.temporary)} + '/' + (String(url).includes('server') ? 'server' : 'desktop')`,
    `  + '.tar.gz'));`,
    'await service.manager().prepare(process.argv[3]);',
  ].join('\n'));
  await fs.writeFile(path.join(box.root, 'update/maintenance'), [
    '#!/bin/sh',
    `exec '${process.execPath}' --import '${hook}' '${worker}' "$@"`,
  ].join('\n'), { mode: 0o700 });
  isolatedEnvironment(t, { PATH: `${stubs}:/usr/bin:/bin` });

  const { runUpdateCommand } = await loadInstalledModule(t, 'cli/updates.ts', box.release.publicKeyPem);
  const output: string[] = [];
  const port = {
    write: (text: string) => output.push(text),
    error: (text: string) => output.push(text),
  };
  const code = await runUpdateCommand({
    kind: 'server',
    action: 'update',
    json: true,
  }, box.root, port);

  assert.equal(code, 0, output.join(''));
  assert.equal((await box.job())?.id, created.id);
  assert.equal((await box.job())?.stage, 'ready');
  assert.equal((await box.job())?.intent, null);
  assert.deepEqual(await box.pointer(), box.previous);
  assert.equal(await fs.stat(path.join(box.root, 'update/server-process.json'))
    .then(() => true, () => false), false);

  for (const action of ['update-status', 'resume-update']) {
    output.length = 0;
    assert.equal(await runUpdateCommand({
      kind: 'server',
      action,
      json: true,
    }, box.root, port), 0);
    assert.equal(JSON.parse(output.join('')).job.id, created.id);
  }

  await box.preserved();
});
