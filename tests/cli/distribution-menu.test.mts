import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  down, exitMenus, launchMenu, menuTitle, sourceMenu,
} from './helpers/menuFixture.mts';
import { assertRestored } from './helpers/pty.mts';

const actions = [
  {
    action: 'check',
    index: 1,
    mode: undefined,
    modeIndex: 0
  },
  {
    action: 'install',
    index: 2,
    mode: 'local',
    modeIndex: 0
  },
  {
    action: 'install',
    index: 2,
    mode: 'remote',
    modeIndex: 1
  },
  {
    action: 'install',
    index: 2,
    mode: 'server',
    modeIndex: 2
  },
] as const;

for (const source of ['official', 'local'] as const) {
  for (const entry of actions) {
    test(`DIST-MENU: ${source} ${entry.action} ${entry.mode ?? ''}`, async (t) => {
      const box = await sourceMenu(t);
      const record = path.join(box.home, 'dist-args.json');
      const value = source === 'official' ? '/tmp/Official Candidate'
        : '67aedc84-5612-4b77-b90c-63c04083fb1d';
      const flag = source === 'official' ? '--from' : '--local-run';
      const tool = [
        "import { writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const target = path.join(process.env.STUB_HOME, 'dist-args.json');",
        'writeFileSync(target, JSON.stringify(process.argv.slice(2)));',
        'process.exitCode = 0;',
      ].join('\n');

      await mkdir(path.join(box.root, 'tools'), { recursive: true });
      await writeFile(path.join(box.root, 'tools/distribution.mts'), tool);

      const session = launchMenu(t, box);

      await session.wait(menuTitle);
      assert.match(session.output(), /Дистрибутив/u);

      let before = session.output().length;

      session.write(down.repeat(8) + '\r');
      await session.wait(/Собрать дистрибутив/u, 4000, before);
      before = session.output().length;
      session.write(down.repeat(entry.index) + '\r');
      await session.wait(/Официальные файлы/u, 4000, before);
      before = session.output().length;
      session.write((source === 'local' ? down : '') + '\r');

      if (entry.mode) {
        await session.wait(/Локально: окно и сервер/u, 4000, before);
        before = session.output().length;
        session.write(down.repeat(entry.modeIndex) + '\r');
      }

      const prompt = source === 'local' ? /UUID собственной сборки/u : /Каталог официальных/u;

      await session.wait(prompt, 4000, before);
      before = session.output().length;
      session.write(value + '\r');
      await box.waitFor(() => existsSync(record));
      await session.wait(/✓ Готово/u, 4000, before);

      const expected = [entry.action, ...entry.mode ? ['--mode', entry.mode] : [], flag, value];

      assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), expected);
      assert.deepEqual(box.requests(), []);
      session.write('\x03');

      const result = await session.done;

      assert.equal(result.code, 130);
      assertRestored(result, session.output());
    });
  }
}

test('DIST-MENU-ESCAPE: Esc в поле значения отменяет команду без эффектов', async (t) => {
  const box = await sourceMenu(t);
  const record = path.join(box.home, 'dist-args.json');
  const tool = [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const target = path.join(process.env.STUB_HOME, 'dist-args.json');",
    'writeFileSync(target, JSON.stringify(process.argv.slice(2)));',
    'process.exitCode = 0;',
  ].join('\n');

  await mkdir(path.join(box.root, 'tools'), { recursive: true });
  await writeFile(path.join(box.root, 'tools/distribution.mts'), tool);

  const session = launchMenu(t, box);

  await session.wait(menuTitle);

  const callsBefore = box.calls();

  session.write(down.repeat(8) + '\r');
  await session.wait(/Собрать дистрибутив/u, 4000);
  session.write(down.repeat(2) + '\r');
  await session.wait(/Официальные файлы/u, 4000);
  session.write('\r');
  await session.wait(/Локально: окно и сервер/u, 4000);
  session.write('\r');
  await session.wait(/Каталог официальных/u, 4000);
  session.write('\x1b');

  await session.wait(menuTitle, 4000);
  assert.ok(!existsSync(record));
  assert.deepEqual(box.calls(), callsBefore);
});

test('DIST-CLI-BAD-UUID: реальный dist отвергает неверный UUID до чтения записи', async (t) => {
  const { completed } = await import('../cli/helpers/sandbox.mts');
  const { spawn } = await import('node:child_process');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const child = spawn(process.execPath,
    [path.join(repository, 'tools/distribution.mts'), 'check',
      '--local-run', 'not-a-uuid'], {
        cwd: repository,
        env: { ...process.env, GRIGDESK_DIST_RUN_DIR: path.join(os.tmpdir(),
        'dist-runs-empty') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  const result = await completed(child);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /distribution_run_id_invalid|dist_source_required/u);
});

test('DIST-MENU-FAILED-DIST: ошибка команды возвращает к меню без потери экрана', async (t) => {
  const box = await sourceMenu(t);
  const tool = "process.stderr.write('команда сломалась\\n'); process.exit(3);";

  await mkdir(path.join(box.root, 'tools'), { recursive: true });
  await writeFile(path.join(box.root, 'tools/distribution.mts'), tool);

  const session = launchMenu(t, box);

  await session.wait(menuTitle);
  session.write(down.repeat(8) + '\r');
  await session.wait(/Собрать дистрибутив/u, 4000);
  session.write('\r');
  await session.wait(/команда сломалась/u, 30_000);
  await session.wait(/Код завершения|код|3/u, 8000);
  session.write('\r');
  await session.wait(menuTitle, 8000);

  // Меню продолжает работать после ошибки; выходим штатно из подменю и меню.
  await exitMenus(session);

  const result = await session.done;

  assert.equal(result.code, 0);
  assertRestored(result, session.output());
});

test('DIST-MENU-BUILD: шкала обновляется во время команды и показывает 100% после успеха', async (t) => {
  const box = await sourceMenu(t);
  const gate = path.join(box.home, 'finish-dist');
  const tool = [
    "import { existsSync } from 'node:fs';",
    "import { setTimeout as pause } from 'node:timers/promises';",
    "import { createDistributionProgress } from '../cli/distributionProgress.ts';",
    'const progress = createDistributionProgress();',
    'progress.plan(2);',
    "progress.phase('snapshot');",
    'progress.completed();',
    "const observer = progress.observer('/tmp/pipeline-server.log', 'server');",
    "observer.start({ id: 'server-tests' });",
    "observer.output('Проверка идёт\\n', 'stdout');",
    `while (!existsSync(${JSON.stringify(gate)})) await pause(20);`,
    'progress.success();',
    "console.log('Кандидат: /tmp/test-candidate');",
  ].join('\n');

  await mkdir(path.join(box.root, 'tools'), { recursive: true });
  await writeFile(path.join(box.root, 'tools/distribution.mts'), tool);

  const session = launchMenu(t, box);

  await session.wait(menuTitle);
  session.write(down.repeat(8) + '\r');
  await session.wait(/Собрать дистрибутив/u);
  session.write('\r');
  await session.wait(/50%  Сервер · Серверные тесты  › Проверка идёт/u);
  assert.match(session.output(), /\/tmp\/pipeline-server\.log/u);
  assert.doesNotMatch(session.output(), /100%/u);

  await writeFile(gate, '');
  await session.wait(/100%/u);
  await session.wait(/Кандидат: \/tmp\/test-candidate/u);
  await session.wait(/Enter \/ Esc — назад/u);
  await exitMenus(session);

  const result = await session.done;

  assert.equal(result.code, 0, session.output());
  assertRestored(result, session.output());
});
