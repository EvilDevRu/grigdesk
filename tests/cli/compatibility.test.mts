import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { HELP_TEXT } from '../../cli/args.ts';
import { fixture, expectedBuildCalls } from '../server/helpers/ctlBuildFixture.js';
import { createSandbox } from './helpers/sandbox.mts';
import { startPty, assertRestored } from './helpers/pty.mts';
import { menuTitle } from './helpers/menuFixture.mts';

for (const [inputTTY, outputTTY] of [[false, false], [true, false], [false, true]]) {
  test(`COMP-01 барьер: справка без меню, TTY=${inputTTY}/${outputTTY}`, async (t) => {
    const box = await createSandbox(t);

    box.installWindow();
    box.installRuntime();

    const session = startPty(t, {
      argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl')],
      env: box.environment,
      inputTTY,
      outputTTY,
    });
    const result = await session.done;

    assert.equal(result.code, 0, session.output());
    assertRestored(result, session.output());
    assert.doesNotMatch(session.output(), menuTitle);
    assert.match(session.output(), /grigdesk-ctl server start/u);
    assert.deepEqual(box.calls(), []);
    assert.deepEqual(box.requests(), []);
  });
}

test('COMP-02 барьер: два TTY в cgroup службы показывают справку без эффектов', async (t) => {
  const box = await createSandbox(t);

  await writeFile(path.join(box.home, 'cgroup'), '0::/user.slice/grigdesk-server.service');

  const session = startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl')],
    env: box.environment,
  });
  const result = await session.done;

  assert.equal(result.code, 0);
  assert.match(session.output(), /grigdesk-ctl server start/u);
  assert.doesNotMatch(session.output(), menuTitle);
  assert.deepEqual(box.calls(), []);
  assertRestored(result, session.output());
});

test('COMP-03 барьер: точные help, ошибка, status JSON и plain build', async (t) => {
  const box = await createSandbox(t);
  const help = await box.run(['--help']);
  const invalid = await box.run(['unknown']);
  const status = await box.run(['server', 'status', '--json']);

  assert.deepEqual(help, {
    code: 0,
    stdout: HELP_TEXT,
    stderr: '',
  });
  assert.deepEqual(invalid, {
    code: 2,
    stdout: '',
    stderr: 'Неизвестная команда: unknown. Справка: grigdesk-ctl --help\n',
  });
  assert.equal(status.code, 0);
  assert.equal(status.stderr, '');
  assert.deepEqual(JSON.parse(status.stdout), {
    server: {
      state: 'stopped',
      managed: true,
      url: `http://127.0.0.1:${box.port}/`,
      reason: null,
    },
  });

  const build = await fixture(t, { binary: false });
  const stubs = build.env.PATH.split(':')[0];

  assert.ok(stubs, 'В PATH фикстуры нет каталога заглушек');

  const npm = path.join(stubs, 'npm');
  const original = await readFile(npm, 'utf8');

  await writeFile(npm, original.replace('process.exit(',
    'console.log("npm-out"); console.error("npm-err"); process.exit('), { mode: 0o755 });

  const result = await build.run(['build', 'web']);

  assert.deepEqual(result, {
    code: 0,
    stdout: `npm-out\n→ Сборка web…\nnpm-out\nСобран веб: ${build.root}/web/dist\n`
      + 'Окно покажет новый веб после grigdesk-ctl build window.\n',
    stderr: 'npm-err\nnpm-err\n',
  });
  assert.deepEqual(await build.calls(), expectedBuildCalls(build, 'web'));
  await build.fail('npm', 'build', 23);

  const failed = await build.run(['build', 'web']);

  assert.deepEqual(failed, {
    code: 23,
    stdout: 'npm-out\n→ Сборка web…\nnpm-out\n',
    stderr: 'npm-err\nnpm-err\nне удалось: web\n',
  });
});

test('COMP-04 барьер: исходники с ELF и Node 20 показывают справку через helper', async (t) => {
  const { binaryFixture } = await import('../server/helpers/ctlBinaryFixture.js');
  const { mkdir, readFile } = await import('node:fs/promises');
  const box = await binaryFixture(t);

  for (const marker of ['server/src/app.ts', 'web/package.json', 'desktop/package.json']) {
    await mkdir(path.dirname(path.join(box.root, marker)), { recursive: true });
    await writeFile(path.join(box.root, marker), '{}');
  }

  await writeFile(path.join(box.env.PATH, 'node'), '#!/bin/bash\necho 20.0.0\n', { mode: 0o755 });
  await writeFile(path.join(box.root, 'bin/grigdesk-app'), [
    '#!/bin/bash',
    'echo fixture-open >> "$STUB_LOG"',
  ].join('\n'), { mode: 0o755 });

  const descriptor = path.join(box.home, '.local/share/grigdesk/desktop/runtime.json');

  await mkdir(path.dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({
    version: 1,
    root: box.root,
    node: process.execPath,
  }));

  const session = startPty(t, {
    argv: ['/bin/bash', path.join(box.root, 'bin/grigdesk-ctl')],
    env: { ...box.env, DISPLAY: ':99' },
  });
  const result = await session.done;

  assert.equal(result.code, 0, session.output());
  assert.doesNotMatch(session.output(), menuTitle);
  assert.doesNotMatch(session.output(), /node не найден|требует Node/u);
  assert.match(session.output(), /grigdesk-ctl server start/u);
  assert.doesNotMatch(await readFile(box.env.STUB_LOG, 'utf8'), /fixture-open|systemctl/u);
  assert.match(await box.calls(), /elf --prepare/u);
  assertRestored(result, session.output());
});

test('COMP-05 барьер: оболочка явно просит справку у ранее собранного helper', async (t) => {
  const { binaryFixture } = await import('../server/helpers/ctlBinaryFixture.js');
  const box = await binaryFixture(t);
  const helper = path.join(box.runtime, 'server/runtime/helpers/grigdesk-cli.mjs');

  await writeFile(helper, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');

  const result = await box.run('bin/grigdesk-ctl');

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['--help']);
  assert.doesNotMatch(await box.calls(), /systemctl/u);
});
