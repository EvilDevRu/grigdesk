import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Песочница лаунчера: ОТДЕЛЬНЫЙ корень репозитория с копией bin/launch и заглушкой вместо
 * bin/restart. Настоящий скрипт перезапуска здесь звать нельзя ни при каких условиях: он
 * гасит процессы на портах кокпита, а агент из чата — дочерний процесс сервера, и прогон
 * убил бы сам себя. По той же причине порт берётся из .env песочницы, а не корневого.
 *
 * Живость сервера изображает поддельный curl: первые `aliveAfter` опросов отвечают отказом,
 * дальше успехом — так проверяется и ожидание подъёма, и открытие окна ровно по факту ответа.
 */
function sandbox(t, { unit = true, aliveAfter = 0, port = 18149 } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cockpit-launch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const fakeBin = path.join(home, 'fake-bin');
  const log = path.join(home, 'calls.log');
  const counter = path.join(home, 'curl-calls');

  mkdirSync(path.join(repo, 'bin', 'lib'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  copyFileSync(path.join(root, 'bin', 'launch'), path.join(repo, 'bin', 'launch'));
  copyFileSync(
    path.join(root, 'bin', 'lib', 'runtime-env.sh'),
    path.join(repo, 'bin', 'lib', 'runtime-env.sh'),
  );
  writeFileSync(path.join(repo, '.env'), `COCKPIT_PORT=${port}\n`);
  writeFileSync(
    path.join(repo, 'bin', 'restart'),
    `#!/usr/bin/env bash\necho "bin/restart $*" >> "${log}"\n`,
    { mode: 0o755 },
  );
  if (unit) {
    const unitDir = path.join(home, '.config', 'systemd', 'user');

    mkdirSync(unitDir, { recursive: true });
    writeFileSync(path.join(unitDir, 'cockpit-server.service'), '[Unit]\n');
  }

  const fake = (name, body) => {
    const text = `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`;

    writeFileSync(path.join(fakeBin, name), text, { mode: 0o755 });
  };
  fake('curl', [
    `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
    `echo $((n + 1)) > "${counter}"`,
    `[ "$n" -ge ${aliveAfter} ]`,
  ].join('\n'));
  fake('systemctl', '');
  fake('xdg-open', '');
  fake('notify-send', '');

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${fakeBin}:${process.env.PATH}`,
    COCKPIT_LAUNCH_WAIT_SEC: '3',
  };

  // Порты живого сервера приехали бы наследованным окружением (оно старше .env) — тогда
  // песочница целилась бы в настоящий кокпит.
  delete env.COCKPIT_PORT;
  delete env.COCKPIT_TLS_PORT;
  const run = () => spawnSync('bash', [path.join(repo, 'bin', 'launch')], {
    encoding: 'utf8', env, timeout: 60_000,
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

  return { home, repo, port, run, calls };
}

test('живой сервер: лаунчер просто открывает окно, ничего не запуская', (t) => {
  const box = sandbox(t);

  const result = box.run();

  assert.equal(result.status, 0, result.stderr);
  assert.ok(box.calls().includes(`xdg-open http://localhost:${box.port}/`), box.calls().join('\n'));
  assert.ok(!box.calls().some((call) => call.startsWith('systemctl ')), 'живой сервер не трогаем');
  assert.ok(!box.calls().some((call) => call.startsWith('bin/restart')));
});

test('спящий сервер с юнитом: systemctl --user start, затем окно', (t) => {
  const box = sandbox(t, { aliveAfter: 2 });

  const result = box.run();

  assert.equal(result.status, 0, result.stderr);
  assert.ok(box.calls().includes('systemctl --user start cockpit-server.service'));
  assert.ok(
    !box.calls().some((call) => call.startsWith('bin/restart')),
    'режимы не смешиваем: bin/restart против юнита поднял бы второй экземпляр',
  );
  assert.ok(box.calls().some((call) => call.startsWith('xdg-open ')));
});

test('без юнита — bin/restart; окно открывается только после ответа сервера', (t) => {
  const box = sandbox(t, { unit: false, aliveAfter: 2 });

  const result = box.run();

  assert.equal(result.status, 0, result.stderr);
  assert.ok(box.calls().some((call) => call.startsWith('bin/restart')));
  assert.ok(!box.calls().some((call) => call.startsWith('systemctl ')));
  const opened = box.calls().findIndex((call) => call.startsWith('xdg-open '));
  const probes = box.calls().slice(0, opened).filter((call) => call.startsWith('curl ')).length;
  assert.ok(probes >= 3, `окно открыто после ${probes} опросов — ждать сервер обязательно`);
});

test('сервер не поднялся: код 1 и уведомление с путями журналов', (t) => {
  const box = sandbox(t, { aliveAfter: 10_000 });

  const result = box.run();

  assert.equal(result.status, 1);
  assert.ok(!box.calls().some((call) => call.startsWith('xdg-open ')), 'пустое окно не открываем');
  const notice = box.calls().filter((call) => call.startsWith('notify-send ')).join('\n');
  assert.match(notice, /journalctl/);
  assert.match(result.stdout, /cockpit-server\.log/);
});

test('порт берётся из .env своего корня — лаунчер и сервер открывают один адрес', (t) => {
  const box = sandbox(t, { port: 18151 });

  const result = box.run();

  assert.equal(result.status, 0, result.stderr);
  assert.ok(box.calls().includes('xdg-open http://localhost:18151/'), box.calls().join('\n'));
});
