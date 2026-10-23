import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { fixture } from '../../server/helpers/ctlBuildFixture.js';
import { repository, menuTitle, down } from './menuFixture.mts';
import { startPty } from './pty.mts';

/**
 * Та же build-фикстура получает настоящий CLI вместо справочного стаба.
 * Все сборщики, установщики и системные команды остаются отдельными безопасными заглушками.
 */
export async function terminalBuildFixture(t: TestContext) {
  const box = await fixture(t, { binary: false });

  for (const name of ['cli', 'shared/i18n', 'shared/runtime', 'shared/desktop', 'shared/node',
    'server/src/lib/runtimePaths.ts', 'server/src/lib/runtimeBuildContext.ts', 'VERSION']) {
    await cp(path.join(repository, name), path.join(box.root, name), { recursive: true });
  }

  const cgroup = path.join(box.env.HOME, 'cgroup');
  const calls = path.join(box.env.HOME, 'menu-calls');
  const stubs = box.env.PATH.split(':')[0];

  assert.ok(stubs, 'В PATH фикстуры нет каталога заглушек');
  await writeFile(cgroup, '0::/user.slice/test.scope');

  const env = Object.assign(box.env, {
    GRIGDESK_CLI_CGROUP_FILE: cgroup,
    LC_ALL: '',
    LC_MESSAGES: '',
    LANG: 'ru_RU.UTF-8',
    TERM: 'xterm',
    DISPLAY: ':99',
    STUB_HOME: box.env.HOME,
  });

  for (const name of ['systemctl', 'journalctl', 'docker', 'xdg-open', 'notify-send']) {
    await writeFile(path.join(stubs, name), [
      '#!/bin/bash',
      `printf '${name} %s\\n' "$*" >> '${calls}'`,
      name === 'systemctl' ? 'echo "LoadState=not-found"' : 'true',
    ].join('\n'), { mode: 0o755 });
  }

  const descriptor = path.join(box.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');

  await mkdir(path.dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({
    version: 1,
    root: box.root,
    node: process.execPath,
  }));
  await writeFile(path.join(box.root, 'bin/grigdesk-app'), [
    '#!/bin/bash',
    `echo fixture-open >> '${calls}'`,
  ].join('\n'), { mode: 0o755 });

  const npm = path.join(stubs, 'npm');
  const original = await readFile(npm, 'utf8');
  const insert = [
    'process.stdout.write("fixture-out " + args.join(" ") + "\\n");',
    'process.stderr.write("fixture-err\\n");',
    'if (args.includes("build:binary")) process.stdout.write("inner-elf-line\\n");',
    'if (failure.command === command && args.includes(failure.argument)) {',
    '  for (let index = 1; index <= 25; index++) process.stderr.write(`tail-${index}\\n`);',
    '}',
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);',
  ].join('\n');

  await writeFile(npm, original.replace('process.exit(', insert + '\nprocess.exit('), { mode: 0o755 });

  // Контракт bundle подтверждается отдельно настоящим executeBundle на маленьком payload.
  // Для меню здесь проверяется делегирование той же команды и принятие её событий.
  await writeFile(path.join(box.root, 'tools/bundle.mts'), [
    'import fs from "node:fs";',
    'for (const id of ["server", "b24", "relay", "deepseek", "window", "verify", "pack", "publish"]) {',
    '  if (process.env.GRIGDESK_CTL_BUILD_OBSERVED === "1") {',
    '    fs.writeSync(3, `start\\tbundle.${id}\\n`);',
    '  }',
    '  console.log(`bundle-${id}-out`);',
    '  console.error(`bundle-${id}-err`);',
    '  if (id === "pack" && fs.existsSync(process.env.HOME + "/bundle-fail")) {',
    '    if (process.env.GRIGDESK_CTL_BUILD_OBSERVED === "1") {',
    '      fs.writeSync(3, `end\\tbundle.${id}\\t27\\n`);',
    '    }',
    '    process.exit(27);',
    '  }',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);',
    '  if (process.env.GRIGDESK_CTL_BUILD_OBSERVED === "1") {',
    '    fs.writeSync(3, `end\\tbundle.${id}\\t0\\n`);',
    '  }',
    '}',
    'console.log("Готовы release/, release.tar.gz и release.tar.gz.sha256.");',
  ].join('\n'));

  return { ...box, env };
}

/**
 * Сборка выбирается настоящими клавишами меню или явным argv под тем же PTY.
 * В неполном TTY и cgroup проверяется прежнее делегирование, без нового журнала.
 */
export function launchBuild(t: TestContext, box: Awaited<ReturnType<typeof terminalBuildFixture>>,
  target: string, menu = false, options: Partial<Parameters<typeof startPty>[1]> = {}) {
  return startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl'), ...menu ? [] : ['build', target]],
    env: box.env,
    ...options,
  });
}

/**
 * Порядок пунктов совпадает с заданием: all/server/web/window/bundle.
 * Ожидание подменю не зависит от скорости запуска Node или системных команд.
 */
export async function chooseBuild(session: ReturnType<typeof startPty>, target: string) {
  await session.wait(menuTitle);

  const before = session.output().length;

  session.write(down.repeat(5) + '\r');
  await session.wait(/Переносимый комплект|Portable bundle/iu, 4000, before);
  session.write(down.repeat(['all', 'server', 'web', 'window', 'bundle'].indexOf(target)) + '\r');
}

/**
 * Сначала проверяет физический журнал в тестовой D, а затем читает его байты.
 * Постоянное имя обязано вести на последний собственный журнал после выхода CLI.
 */
export async function buildLog(box: Awaited<ReturnType<typeof terminalBuildFixture>>) {
  const directory = path.join(box.env.GRIGDESK_HOME, 'artifacts/ctl-build');
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException): string[] => {
    assert.equal(error.code, 'ENOENT');

    return [];
  });

  assert.ok(files.includes('latest.log'), 'Полный журнал latest.log не создан в тестовой D');

  return {
    directory,
    files,
    text: await readFile(path.join(directory, 'latest.log'), 'utf8'),
  };
}
