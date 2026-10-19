import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { helperFixture, runFile, SOURCE_ROOT } from './helperFixture.mts';

test('SEA-SELECT-HELPER: собранный CLI выбирает пакет из чужого cwd и очищает env проверки', async (t) => {
  const fixture = await helperFixture(t, ['select-sea-server']);
  const root = path.join(fixture.temporary, 'package with space');
  const home = path.join(fixture.temporary, 'home');
  const data = path.join(fixture.temporary, 'data');
  const xdg = path.join(fixture.temporary, 'xdg');
  const descriptor = path.join(xdg, 'grigdesk/desktop/runtime.json');
  const binary = path.join(root, 'server/grigdesk-server');

  for (const directory of [path.dirname(binary), home, data, path.dirname(descriptor)]) {
    await mkdir(directory, { recursive: true });
  }

  await writeFile(binary, [
    '#!/bin/sh',
    'test "$#" -eq 1 && test "$1" = --check-runtime || exit 42',
    'test -z "${NODE_OPTIONS+x}" || exit 43',
    'printf \'{"ok":true}\\n\'',
  ].join('\n'));
  await chmod(binary, 0o755);
  await writeFile(descriptor, JSON.stringify({
    version: 1,
    root: '/fixture/old',
    node: '/fixture/node',
  }));
  await writeFile(path.join(path.dirname(descriptor), 'runtime-version'), '3\n');

  const result = await runFile(fixture.node, [fixture.entry('select-sea-server'), root], {
    cwd: '/',
    env: {
      PATH: '/nonexistent',
      HOME: home,
      XDG_DATA_HOME: xdg,
      GRIGDESK_HOME: data,
      NODE_OPTIONS: '--max-old-space-size=512',
    },
    timeout: 30000,
  });

  assert.match(result.stdout, /Выбран сервер GrigDesk/);
  assert.deepEqual(JSON.parse(await readFile(descriptor, 'utf8')), {
    version: 3,
    kind: 'sea',
    root,
    home: data,
  });

  const backup = await readFile(`${descriptor}.previous`, 'utf8');
  const sourceCli = await runFile('bash', [
    path.join(SOURCE_ROOT, 'bin/grigdesk-ctl'), 'desktop', 'use-server', root,
  ], {
    cwd: '/',
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      XDG_DATA_HOME: xdg,
      GRIGDESK_HOME: data,
    },
    timeout: 30000,
  });

  assert.match(sourceCli.stdout, /Выбран сервер GrigDesk/);
  assert.equal(await readFile(`${descriptor}.previous`, 'utf8'), backup);
});
