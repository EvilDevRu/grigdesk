import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

import { assertRestored } from './helpers/pty.mts';
import { visibleLines, exitMenus } from './helpers/menuFixture.mts';
import {
  terminalBuildFixture, launchBuild, chooseBuild, buildLog,
} from './helpers/buildFixture.mts';

const totalTime = /(?:Общее время|Всего|Total (?:time|elapsed))\s*:/iu;

/**
 * Меню сохраняет успешный итог до клавиши, затем возвращает выбор команд.
 * Явная сборка проверяется отдельно и никогда не получает завершающий Enter.
 */
async function leaveSuccessfulMenu(session: ReturnType<typeof launchBuild>) {
  await session.wait(totalTime, 10000);

  const result = await exitMenus(session);

  assert.equal(result.code, 0, session.output());
  assertRestored(result, session.output());
}

for (const target of ['all', 'server', 'web', 'window', 'bundle']) {
  for (const locale of ['ru_RU.UTF-8', 'en_US.UTF-8']) {
    test(`BS-RESULTS/SUMMARY: меню ${target}, ${locale}, шаги, прогресс, полный журнал и итог`, async (t) => {
      const box = await terminalBuildFixture(t);
      const session = launchBuild(t, box, target, true, {
        env: {
          ...box.env,
          LC_ALL: '',
          LC_MESSAGES: '',
          LANG: locale,
        },
      });

      await chooseBuild(session, target);
      await session.wait(totalTime, 10000);

      const output = session.output();

      assert.match(output, /✓/u);
      assert.match(output, /[◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
      assert.match(output, /[█▓━=].*\d+%/u);
      assert.match(output, /\d+:\d{2}/u);
      assert.match(output, /≈/u);
      assert.match(output, /100%/u);
      assert.match(output, locale.startsWith('ru') ? /Журнал/u : /Log/u);
      assert.match(output, locale.startsWith('ru') ? /Сборка/u : /Build/iu);

      const log = await buildLog(box);

      if (target === 'bundle') {
        for (const id of ['server', 'b24', 'relay', 'deepseek', 'window', 'verify', 'pack', 'publish']) {
          assert.ok(log.text.includes(`bundle-${id}-out`));
          assert.ok(log.text.includes(`bundle-${id}-err`));
        }

        assert.match(output, /release\/|release\.tar\.gz/u);
      } else {
        assert.match(log.text, /fixture-out/u);
        assert.match(log.text, /fixture-err/u);

        if (target === 'all' || target === 'server') {
          assert.match(log.text, /inner-elf-line/u);
          assert.match(output, /grigdesk-ctl desktop use-server/u);
        }

        if (target === 'web') {
          assert.match(output, /grigdesk-ctl build window/u);
          assert.doesNotMatch(output, /Закройте окно|Close the window/iu);
        } else {
          assert.match(output, locale.startsWith('ru') ? /Закройте окно/iu : /Close.*window/iu);
        }
      }

      const calls = await box.calls();

      assert.ok(!calls.some((call) => /systemctl|xdg-open/u.test(call.command)));
      await leaveSuccessfulMenu(session);
    });
  }
}

for (const [command, argument, code] of [
  ['node', 'prepare-runtime', 1],
  ['npm', 'install', 26],
  ['npm', 'build:binary', 21],
  ['npm', 'install:binary', 22],
  ['npm', 'build', 23],
  ['npm', 'dist', 24],
  ['desktop', 'install', 25],
] as const) {
  test(`BS-RESULTS: отказ ${argument} показывает ✗, код, хвост и завершает CLI`, async (t) => {
    const box = await terminalBuildFixture(t);

    if (command === 'node') {
      await writeFile(path.join(box.root, 'server/build/node-runtime.json'), '{}');
    } else {
      await box.fail(command, argument, code);
    }

    if (argument === 'install' && command === 'npm') {
      await rm(path.join(box.root, 'server/node_modules'), { recursive: true });
    }

    const session = launchBuild(t, box, 'all', true);

    await chooseBuild(session, 'all');

    const result = await session.done;

    assert.equal(result.code, code, session.output());
    assert.match(session.output(), /✗/u);
    assert.ok(session.output().includes(String(code)));
    assert.match(session.output(), /Сервер|Веб|Окно/iu);
    assert.match(session.output(), /Журнал/u);
    assert.doesNotMatch(session.output(), /100%/u);
    assertRestored(result, session.output());

    const log = await buildLog(box);

    if (command === 'node') {
      assert.match(log.text, /Некорректный.*node-runtime/u);
    } else {
      assert.match(log.text, /fixture-out/u);
      assert.match(log.text, /fixture-err/u);
    }

    if (command === 'npm') {
      assert.match(log.text, /tail-1\n/u);
      assert.match(log.text, /tail-25\n/u);

      const failureScreen = session.output().slice(session.output().lastIndexOf('✗'));

      const tail = log.text.trimEnd().split(/\r?\n/u).slice(-20);

      for (const line of tail) {
        assert.ok(failureScreen.includes(line), `Нет строки хвоста: ${line}`);
      }

      assert.doesNotMatch(failureScreen, /tail-[1-5](?:\r?\n|$)/u);
    }
  });
}

for (const failure of [false, true]) {
  test(`BS-DIRECT/BS-DIRECT-EXIT: явный build сам выходит без ввода, отказ=${failure}`, async (t) => {
    const box = await terminalBuildFixture(t);

    if (failure) {
      await box.fail('npm', 'build', 23);
    }

    const session = launchBuild(t, box, 'web');
    const result = await session.done;

    assert.equal(result.timedOut, false, 'Явная сборка ждёт Enter после завершения');
    assert.equal(result.code, failure ? 23 : 0);
    assert.match(session.output(), /Журнал/u, 'TTY build должен использовать экран прогресса');
    assert.match(session.output(), failure ? /✗/u : /100%/u);

    if (!failure) {
      assert.match(session.output(), /grigdesk-ctl build window/u);
      assert.match(session.output(), totalTime);
    }

    assertRestored(result, session.output());
    await buildLog(box);
  });
}

for (const mode of ['agent', 'stdin-pipe', 'stdout-pipe']) {
  test(`BS-DIRECT барьер: ${mode}, прежний поток и отсутствие рекурсии/новых журналов`, async (t) => {
    const box = await terminalBuildFixture(t);

    if (mode === 'agent') {
      await writeFile(box.env.GRIGDESK_CLI_CGROUP_FILE, '0::/user.slice/grigdesk-server.service');
    }

    const session = launchBuild(t, box, 'web', false, {
      inputTTY: mode !== 'stdin-pipe',
      outputTTY: mode !== 'stdout-pipe',
    });
    const result = await session.done;
    const { stat } = await import('node:fs/promises');

    assert.equal(result.code, 0, session.output());
    assert.equal(result.timedOut, false);
    assert.match(session.output(), /fixture-out/u);
    assert.doesNotMatch(session.output(), /Журнал|\d+%/u);
    assert.equal((await box.calls()).length, 2);
    await assert.rejects(stat(path.join(box.env.GRIGDESK_HOME, 'artifacts/ctl-build')), { code: 'ENOENT' });
  });
}

test('BS-STDIN: дочерний read получает EOF, сборка не останавливается по SIGTTIN', async (t) => {
  const box = await terminalBuildFixture(t);
  const stubs = box.env.PATH.split(':')[0];

  assert.ok(stubs, 'В PATH фикстуры нет каталога заглушек');

  const npm = path.join(stubs, 'npm');
  const pidFile = path.join(box.env.HOME, 'reader-pid');

  await rename(npm, `${npm}.real`);
  await writeFile(npm, [
    '#!/bin/bash',
    `echo $$ > '${pidFile}'`,
    'read -r -t 3 line',
    'printf "stdin-read=%s\\n" "$?"',
    'exec "${BASH_SOURCE[0]}.real" "$@"',
  ].join('\n'), { mode: 0o755 });

  const session = launchBuild(t, box, 'web', true);

  await chooseBuild(session, 'web');
  await session.wait(totalTime, 8000);

  const log = await buildLog(box);
  const codes = [...log.text.matchAll(/stdin-read=(\d+)/gu)].map((match) => Number(match[1]));

  assert.ok(codes.length >= 1);
  assert.ok(codes.every((code) => code > 0 && code < 128), 'read должен получить EOF, не timeout');

  const pid = (await readFile(pidFile, 'utf8')).trim();
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');

  assert.doesNotMatch(stat, /\) T /u);
  await leaveSuccessfulMenu(session);
});

test('BS-RESULTS: узкий терминал, resize, NO_COLOR и TERM=dumb без потери полного журнала', async (t) => {
  const box = await terminalBuildFixture(t);
  const stubs = box.env.PATH.split(':')[0];

  assert.ok(stubs, 'В PATH фикстуры нет каталога заглушек');

  const npm = path.join(stubs, 'npm');
  const ready = path.join(box.env.HOME, 'dumb-step-ready');
  const release = path.join(box.env.HOME, 'dumb-step-release');

  // Шаг удерживается без нового вывода и событий, поэтому лишние блоки вызваны таймером.
  // Барьер снимается перед проверками, чтобы ошибка не оставляла сборку ожидающей файл.
  await rename(npm, `${npm}.real`);
  await writeFile(npm, [
    '#!/bin/bash',
    'echo ready > "$STUB_HOME/dumb-step-ready"',
    'while [[ ! -f "$STUB_HOME/dumb-step-release" ]]; do sleep 0.02; done',
    'exec "${BASH_SOURCE[0]}.real" "$@"',
  ].join('\n'), { mode: 0o755 });

  const session = launchBuild(t, box, 'web', true, {
    columns: 40,
    env: {
      ...box.env,
      NO_COLOR: '1',
      TERM: 'dumb',
    },
  });

  await chooseBuild(session, 'web');

  let repeatedBlocks = 0;

  try {
    const deadline = Date.now() + 4000;

    while (!existsSync(ready) && !session.finished() && Date.now() < deadline) {
      await pause(25);
    }

    assert.ok(existsSync(ready), 'Сборочный шаг не достиг файлового барьера');

    const before = session.output().length;

    await pause(800);
    repeatedBlocks = visibleLines(session.output().slice(before))
      .filter((line) => line.startsWith('◇ ')).length;
  } finally {
    await writeFile(release, '');
  }

  await session.wait(totalTime, 10000);
  assert.ok(visibleLines(session.output()).every((line) => [...line].length <= 40), session.output());
  assert.doesNotMatch(session.output(), /\x1b\[[\d;]*m/u);

  const log = await buildLog(box);

  assert.match(log.text, /fixture-out/u);
  assert.match(log.text, /fixture-err/u);
  await leaveSuccessfulMenu(session);
  t.diagnostic(`Блоков прогресса за 800 мс без событий: ${repeatedBlocks}`);
  assert.ok(repeatedBlocks <= 2,
    `TERM=dumb допечатал ${repeatedBlocks} блоков за 800 мс без событий шага`);
});

for (const detached of [false, true]) {
  test(`BS-CANCEL: Ctrl+C завершает своё дерево, setsid=${detached}, чужой процесс жив`, async (t) => {
    const box = await terminalBuildFixture(t);
    const stubs = box.env.PATH.split(':')[0];

    assert.ok(stubs, 'В PATH фикстуры нет каталога заглушек');

    const npm = path.join(stubs, 'npm');
    const pidsFile = path.join(box.env.HOME, 'tree-pids');
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });

    t.after(() => sentinel.kill('SIGKILL'));
    await writeFile(npm, [
      '#!/usr/bin/python3',
      'import json, os, signal, subprocess, time',
      `leaf = subprocess.Popen(['/usr/bin/python3', '-c', ${JSON.stringify([
        'import os, signal, time',
        'signal.signal(signal.SIGINT, signal.SIG_IGN)',
        'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
        'while True: time.sleep(0.1)',
      ].join('\n'))}], start_new_session=${detached ? 'True' : 'False'})`,
      `open(${JSON.stringify(pidsFile)}, 'w').write(json.dumps([os.getpid(), leaf.pid]))`,
      'print("tree-ready", flush=True)',
      'while True: time.sleep(0.1)',
    ].join('\n'), { mode: 0o755 });

    const session = launchBuild(t, box, 'web', true);

    await chooseBuild(session, 'web');
    await session.wait(/tree-ready/u, 8000);

    const pids: number[] = JSON.parse(await readFile(pidsFile, 'utf8'));

    t.after(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        }
      }
    });
    session.write('\x03');

    const result = await session.done;

    assert.equal(result.code, 130, session.output());
    assertRestored(result, session.output());
    assert.equal(sentinel.exitCode, null);
    assert.equal(sentinel.signalCode, null);

    for (const pid of pids) {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');

      assert.ok(!stat || /\) Z /u.test(stat), `Свой процесс ${pid} остался жив: ${stat}`);
    }

    assert.match((await buildLog(box)).text, /прервано/iu);

    const { stat } = await import('node:fs/promises');

    await assert.rejects(stat(path.join(box.env.GRIGDESK_HOME, 'state/ctl-build-timings.json')),
      { code: 'ENOENT' });
  });
}

test('BS-RESULTS: отказ переносимого комплекта показывает pack/27 и не возвращает успех', async (t) => {
  const box = await terminalBuildFixture(t);

  await writeFile(path.join(box.env.HOME, 'bundle-fail'), '');

  const session = launchBuild(t, box, 'bundle', true);

  await chooseBuild(session, 'bundle');

  const result = await session.done;

  assert.equal(result.code, 27, session.output());
  assert.match(session.output(), /✗/u);
  assert.match(session.output(), /27/u);
  assert.match(session.output(), /Журнал/u);
  assert.doesNotMatch(session.output(), /100%/u);
  assertRestored(result, session.output());

  const log = await buildLog(box);

  assert.match(log.text, /bundle-pack-err/u);
  assert.doesNotMatch(log.text, /bundle-publish/u);
});

test('BS-SUMMARY: свой descriptor v4 не порождает подсказку выбора сервера', async (t) => {
  const box = await terminalBuildFixture(t);
  const file = path.join(box.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
  const descriptor = JSON.stringify({
    version: 4,
    kind: 'binary',
    binary: path.join(box.root, 'bin/grigdesk-server'),
    home: box.env.GRIGDESK_HOME,
    cliPaths: [],
  });

  await writeFile(file, descriptor);

  const session = launchBuild(t, box, 'server');
  const result = await session.done;

  assert.equal(result.code, 0, session.output());
  assert.match(session.output(), totalTime);
  assert.doesNotMatch(session.output(), /grigdesk-ctl desktop use-server/u);
  assert.equal(await readFile(file, 'utf8'), descriptor);
});
