import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { completed, createSandbox } from './helpers/sandbox.mts';
import { buildLog, chooseBuild, launchBuild, terminalBuildFixture } from './helpers/buildFixture.mts';
import { down, menuTitle, up, visibleLines } from './helpers/menuFixture.mts';
import { assertRestored, startPty } from './helpers/pty.mts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { DAY, oldTree, retentionFixture } from '../helpers/deepseekRetentionFixture.mts';

test('CTL-GO-01: состояние берётся из указанного физического checkout', async (t) => {
  const fixture = await createSandbox(t, { go: true });
  const other = await createSandbox(t, { go: true });

  fixture.unit({
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    Result: 'success',
    WorkingDirectory: path.join(fixture.root, 'server'),
  });
  other.unit({
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    Result: 'success',
    WorkingDirectory: path.join(fixture.root, 'server'),
  });
  await fixture.serve('grigdesk');
  await other.serve('grigdesk');

  const own = await fixture.run(['status', '--json']);
  const foreign = await other.run(['status', '--json']);

  assert.equal(own.code, 0, own.stderr);
  assert.equal(foreign.code, 0, foreign.stderr);
  assert.equal(JSON.parse(own.stdout).server.state, 'ready');
  assert.equal(JSON.parse(own.stdout).server.managed, true);
  assert.equal(JSON.parse(foreign.stdout).server.state, 'mismatch');
  assert.match(JSON.parse(foreign.stdout).server.reason, /другую копию/u);
});

test('CTL-GO-RELAY: статус читает связи сервера без обращения к Docker', async (t) => {
  const fixture = await createSandbox(t, { go: true });

  await fixture.serve('grigdesk', {
    relays: [{ name: 'Дом', link: { state: 'online' } }],
  });

  const result = await fixture.run(['relay', 'status', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { relay: { links: [{ name: 'Дом', state: 'online' }] } });

  for (const action of ['start', 'stop', 'restart', 'logs']) {
    const removed = await fixture.run(['relay', action]);

    assert.equal(removed.code, 2, removed.stderr);
  }

  assert.ok(fixture.calls().every((call) => !call.startsWith('docker ')));
});

test('CTL-GO-02: меню запускает web-сборку, сохраняет вывод и показывает результат', async (t) => {
  const fixture = await terminalBuildFixture(t, true);
  const session = launchBuild(t, fixture, 'web', true);

  await chooseBuild(session, 'web');
  await session.wait(/50%.*Веб: сборка/u);
  await session.wait(/Сборка завершена|Сборка выполнена/iu);

  const log = await buildLog(fixture);

  assert.match(session.output(), /Веб: зависимости/u);
  assert.match(session.output(), /50%.*Веб: сборка/u);
  assert.match(log.text, /fixture-out.*build/u);
  assert.match(log.text, /fixture-err/u);
  await returnFromBuild(session);
});

for (const outcome of ['failed', 'cancelled'] as const) {
  test(`CTL-GO-07: исход сборки ${outcome} остаётся внутри меню`, async (t) => {
    const fixture = await terminalBuildFixture(t, true);

    if (outcome === 'failed') {
      await fixture.fail('npm', 'build', 17);
    }

    const session = launchBuild(t, fixture, 'web', true);

    await chooseBuild(session, 'web');

    if (outcome === 'cancelled') {
      await session.wait(/Веб: зависимости/u);
      session.write('\x03');
      await session.wait(/Действие прервано/u);
    } else {
      await session.wait(/Команда завершилась с кодом 17/u);
      await session.wait(/tail-25/u);
    }

    await returnFromBuild(session);
  });
}

/**
 * У карточки результата и двух уровней меню общий альтернативный экран.
 * Проверка закрывает весь сеанс только после подтверждения возврата к той же цели.
 */
async function returnFromBuild(session: ReturnType<typeof startPty>) {
  await session.wait(/Enter \/ Esc — назад/u);

  const beforeResult = session.output().length;

  assert.doesNotMatch(session.output(), /\x1b\[\?1049l/u);
  session.write('\r');
  await session.wait(/› Только веб/u, 4000, beforeResult);

  const beforeParent = session.output().length;

  session.write('\x1b');
  await session.wait(menuTitle, 4000, beforeParent);
  assert.doesNotMatch(session.output(), /\x1b\[\?1049l/u);
  session.write('\x1b');

  const result = await session.done;
  const output = session.output();

  assert.equal(result.code, 0);
  assert.equal(output.match(/\x1b\[\?1049h/gu)?.length, 1);
  assert.equal(output.match(/\x1b\[\?1049l/gu)?.length, 1);
  assertRestored(result, output);
}

test('CTL-GO-08: сборка дистрибутива возвращается на тот же экран после результата', async (t) => {
  const fixture = await terminalBuildFixture(t, true);
  const script = path.join(fixture.root, 'tools/distribution.mts');

  await writeFile(script, [
    'if (process.env.GRIGDESK_CTL_DIST_PROGRESS !== "1") process.exit(2);',
    'process.stderr.write("\\r25% Подготовка дистрибутива");',
    'await new Promise((resolve) => setTimeout(resolve, 300));',
    'process.stderr.write("\\r100% Готово\\n");',
    'process.stdout.write("Кандидат собран\\n");',
  ].join('\n'));

  const session = launchBuild(t, fixture, 'web', true);

  await session.wait(menuTitle);

  const root = session.output().length;

  session.write(down.repeat(8) + '\r');
  await session.wait(/› Собрать дистрибутив/u, 4000, root);
  session.write('\r');
  await session.wait(/25% Подготовка дистрибутива/u);
  await session.wait(/Кандидат собран/u);
  await session.wait(/Enter \/ Esc — назад/u);

  const beforeResult = session.output().length;

  session.write('\x1b');
  await session.wait(/› Собрать дистрибутив/u, 4000, beforeResult);
  assert.doesNotMatch(session.output(), /\x1b\[\?1049l/u);
  session.write('\x03');

  const result = await session.done;

  assert.equal(result.code, 130);
  assertRestored(result, session.output());
});

for (const mode of ['color', 'no-color', 'dumb'] as const) {
  test(`CTL-GO-05: меню сохраняет выбор и терминал в режиме ${mode}`, async (t) => {
    const box = await createSandbox(t, { go: true });
    const session = startPty(t, {
      argv: box.argv(),
      env: {
        ...box.environment,
        TERM: mode === 'dumb' ? 'dumb' : 'xterm-256color',
        NO_COLOR: mode === 'no-color' ? '1' : '',
        LC_ALL: 'ru_RU.UTF-8',
      },
      columns: 82,
    });

    await session.wait(menuTitle);

    const root = session.output();

    assert.match(root, /› Открыть окно/u);
    assert.match(root, /Сервер [○●✗]/u);
    assert.match(root, /ПРИЛОЖЕНИЕ/u);
    assert.match(root, /РАЗРАБОТЧИКУ/u);

    if (mode === 'color') {
      assert.match(root, /\x1b\[48;2;27;31;38m/u);
      assert.match(root, /\x1b\[48;2;41;59;67m/u);
    } else {
      assert.doesNotMatch(root, /\x1b\[[\d;]*m/u);
    }
    if (mode === 'dumb') {
      assert.doesNotMatch(root, /\x1b/u);
    }

    const before = session.output().length;

    session.write(down.repeat(2) + '\r');
    await session.wait(/› Запустить/u, 4000, before);

    const resizedAt = session.output().length;

    session.resize(32);
    await session.wait(/Esc назад/u, 4000, resizedAt);
    assert.ok(visibleLines(session.output().slice(resizedAt)).every((line) => [...line].length < 32));

    const backAt = session.output().length;

    session.write('\x1b');
    await session.wait(/› Сервер/u, 4000, backAt);
    session.write(up + '\x03');

    const result = await session.done;
    const output = session.output();

    assert.equal(result.code, 130);
    assertRestored(result, output);

    if (mode !== 'dumb') {
      assert.equal(output.match(/\x1b\[\?1049h/gu)?.length, 1);
      assert.equal(output.match(/\x1b\[\?1049l/gu)?.length, 1);
    }
  });
}

test('CTL-GO-06: подтверждение уборки листает отчёт и возвращает в меню после отмены', async (t) => {
  const box = await createSandbox(t, { go: true });
  const retention = await retentionFixture(t);
  const earlier = Date.now() - 14 * DAY;
  const names = Array.from({ length: 20 }, (_, index) => 'archive-' + String(index).padStart(2, '0'));

  await Promise.all(names.map((name) => oldTree(retention.artifacts, name, 64, earlier)));

  const session = startPty(t, {
    argv: box.argv(),
    env: {
      ...box.environment,
      GRIGDESK_ARTIFACTS_DIR: retention.artifacts,
      TERM: 'xterm-256color',
      LC_ALL: 'ru_RU.UTF-8',
    },
    columns: 82,
    rows: 17,
  });

  await session.wait(menuTitle);
  session.write(down.repeat(7) + '\r');
  await session.wait(/PgUp\/PgDn/u);

  const preview = session.output().length;

  session.write('\x1b[F');
  await session.wait(/archive-19/u, 4000, preview);
  await session.wait(/› Отмена/u, 4000, preview);

  const back = session.output().length;

  session.write('\r');
  await session.wait(menuTitle, 4000, back);
  session.write('\x1b');

  const result = await session.done;

  await stat(path.join(retention.artifacts, 'archive-19'));
  assert.equal(result.code, 0);
  assertRestored(result, session.output());
});

test('CTL-GO-03: события сборки идут по fd 3 и не загрязняют stdout', async (t) => {
  const fixture = await terminalBuildFixture(t, true);
  const [file, ...argv] = fixture.argv(['build', 'web']);
  const child = spawn(file!, argv, {
    env: { ...fixture.env, GRIGDESK_CTL_BUILD_OBSERVED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let events = '';

  child.stdout!.on('data', (data) => stdout += data);
  child.stderr!.resume();
  child.stdio[3]!.on('data', (data) => events += data);

  const [rc] = await once(child, 'close');

  assert.equal(rc, 0);
  assert.match(stdout, /Собран веб/u);
  assert.doesNotMatch(stdout, /start\t|end\t/u);
  assert.equal(events, 'start\tweb.dependencies\nend\tweb.dependencies\t0\n'
    + 'start\tweb.build\nend\tweb.build\t0\n');
});

/**
 * Упаковщик фикстуры требует установленный esbuild, а npm восстанавливает его только с dev-пакетами.
 * Серверная цепочка и Go-сборщики остаются заглушками и не затрагивают живую установку.
 */
async function windowDependenciesFixture(t: Parameters<typeof terminalBuildFixture>[0]) {
  const fixture = await terminalBuildFixture(t, true);
  const desktop = path.join(fixture.root, 'desktop');
  const dependency = path.join(desktop, 'node_modules/esbuild/package.json');
  const npm = path.join(fixture.env.PATH.split(':')[0]!, 'npm');
  const original = await readFile(npm, 'utf8');
  const anchor = 'const failed = failure.command === command && args.includes(failure.argument);';

  assert.ok(original.includes(anchor));
  await writeFile(npm, original.replace(anchor, [
    anchor,
    `const dependency = ${JSON.stringify(dependency)};`,
    `if (process.cwd() === ${JSON.stringify(desktop)} && args.includes('install') && !failed) {`,
    "  if (!args.includes('--include=dev')) process.exit(81);",
    "  fs.mkdirSync(require('node:path').dirname(dependency), { recursive: true });",
    "  fs.writeFileSync(dependency, '{}');",
    '}',
    "if (args.includes('dist') && !fs.existsSync(dependency)) process.exit(82);",
  ].join('\n')));

  for (const name of ['build-factory.sh', 'build-go-utilities.sh']) {
    await writeFile(path.join(fixture.root, 'tools', name), '#!/bin/bash\nexit 0\n');
  }

  return {
    fixture,
    desktop,
    dependency,
  };
}

for (const target of ['all', 'window']) {
  for (const installed of [false, true]) {
    test(`CTL-GO-DEPS: ${target} восстанавливает dev-пакеты окна, node_modules=${installed}`, {
      skip: process.platform !== 'linux',
    }, async (t) => {
      const { fixture, desktop, dependency } = await windowDependenciesFixture(t);

      if (installed) {
        await mkdir(path.join(desktop, 'node_modules'));
      }

      const [file, ...argv] = fixture.argv(['build', target]);
      const result = await completed(spawn(file!, argv, {
        env: {
          ...fixture.env,
          NODE_ENV: 'production',
          npm_config_omit: 'dev',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      const calls = await fixture.calls();
      const dependencies = calls.findIndex((call: { cwd: string; args: string[] }) =>
        call.cwd === desktop && call.args.includes('install'));
      const packaged = calls.findIndex((call: { args: string[] }) => call.args.includes('dist'));

      assert.equal(result.code, 0, result.stderr);
      await stat(dependency);
      assert.ok(dependencies >= 0);
      assert.ok(packaged > dependencies);
      assert.ok(calls.some((call: { command: string }) => call.command === 'desktop'));
    });
  }

  test(`CTL-GO-DEPS: ${target} сохраняет окно при отказе установки зависимостей`, {
    skip: process.platform !== 'linux',
  }, async (t) => {
    const { fixture } = await windowDependenciesFixture(t);

    await fixture.fail('npm', '--include=dev', 31);

    const [file, ...argv] = fixture.argv(['build', target]);
    const result = await completed(spawn(file!, argv, {
      env: fixture.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const calls = await fixture.calls();

    assert.equal(result.code, 31, result.stderr);
    assert.ok(!calls.some((call: { args: string[] }) => call.args.includes('dist')));
    assert.ok(!calls.some((call: { command: string }) => call.command === 'desktop'));
  });
}

test('CTL-GO-04: уборка не трогает живой Node lock и внешнюю цель ссылки', async (t) => {
  const fixture = await createSandbox(t, { go: true });
  const retention = await retentionFixture(t);

  await mkdir(retention.artifacts, { recursive: true });

  const protectedPath = await oldTree(retention.artifacts, 'locked', 87, Date.now() - 14 * DAY);
  const deletable = await oldTree(retention.artifacts, 'expired', 248, Date.now() - 14 * DAY);
  const external = await oldTree(fixture.home, 'external', 31, Date.now() - 14 * DAY);
  const lock = await acquireDirectoryLock(protectedPath + '.lock');

  t.after(() => lock.release());
  await symlink(external, path.join(retention.artifacts, 'linked'));

  const env = { GRIGDESK_ARTIFACTS_DIR: retention.artifacts };
  const preview = await fixture.run(['artifacts-cleanup', '--dry-run', '--json'], env);

  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).wouldDeleteBytes, 248);
  await stat(deletable);

  const result = await fixture.run(['artifacts-cleanup', '--json'], env);
  const report = JSON.parse(result.stdout);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(report.freedBytes, 248);
  assert.equal(report.entries.find((entry: { path: string }) => entry.path === 'locked').reason, 'locked');
  await stat(protectedPath);
  await stat(external);
  await assert.rejects(() => stat(deletable), { code: 'ENOENT' });
});
