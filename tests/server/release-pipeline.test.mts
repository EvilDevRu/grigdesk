import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { TestContext } from 'node:test';

import { collectBuildProcesses } from '../../cli/buildProcesses.ts';
import {
  runStages, decodeRecipe, recipeDigest, type ReleaseRecipe, type RecipeStage,
} from '../../tools/releasePipeline.mts';

/**
 * Фикстура даёт настоящему runner-у управляемые child-процессы node.
 * Диспетчер, ворота и receipt не подменяются; marker доказывает отсутствие эффекта.
 */
async function pipelineFixture(t: TestContext) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-pipeline-'));
  const receiptDir = path.join(workDir, 'receipts');
  const marker = path.join(workDir, 'bundle.marker');
  let serial = 0;

  t.after(() => fs.rm(workDir, { recursive: true, force: true }));

  return {
    workDir,
    receiptDir,
    marker,
    step(id: string, group: string, source: string, needs: string[] = [],
      argv: string[] = []): RecipeStage {
      return {
        id,
        group,
        needs,
        argv: [process.execPath, '-e', source, ...argv]
      };
    },
    run(recipe: ReleaseRecipe) {
      // Каждому прогону — собственный лог-файл: флаг wx не допускает повторного
      // открытия, а receipt-ы и так разделяются по runId.
      serial += 1;

      return runStages({
        recipe,
        cwd: workDir,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: workDir,
          TMPDIR: workDir
        },
        logFile: path.join(workDir, `pipeline-${serial}.log`),
        receiptDir
      });
    },
  };
}

test('PIPELINE-FAIL: ошибка теста не запускает упаковку', async (t) => {
  const box = await pipelineFixture(t);
  const recipe: ReleaseRecipe = { format: 1, stages: [
    box.step('tests-a', 'tests', 'process.exit(7)'),
    box.step('tests-b', 'tests', 'process.stdout.write("independent done\\n")'),
    {
      id: 'bundle',
      group: 'build',
      needs: ['tests'],
      argv: [process.execPath, '-e',
        'require("fs").writeFileSync(process.argv[1], "bad")', box.marker]
    },
  ] };

  const result = await box.run(recipe);

  assert.notEqual(result.code, 0);
  assert.equal(result.outcomes['tests-a']!.exitCode, 7);
  assert.equal(result.outcomes['tests-b']!.status, 'success');
  assert.equal(result.outcomes.bundle!.status, 'blocked');
  await assert.rejects(fs.stat(box.marker), { code: 'ENOENT' });
});

test('PIPELINE-PROCESSES: законченные потомки не накапливаются при проверках', async (t) => {
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100);'], { stdio: 'ignore' });
  const finished = once(worker, 'close');

  t.after(() => {
    worker.kill();
  });

  const known = await collectBuildProcesses(worker.pid!);

  assert.equal(known[0]?.pid, worker.pid);
  worker.kill();
  await finished;

  const collected = await collectBuildProcesses(process.pid, known);

  assert.equal(collected.some((item) => item.pid === worker.pid), false);
  assert.deepEqual(await collectBuildProcesses(worker.pid!, known), known);
});

test('PIPELINE-CANCEL-TRAPS-TERM: exit 0 ребёнка после SIGINT не возвращает успех', async (t) => {
  const box = await pipelineFixture(t);
  const started = path.join(box.workDir, 'child-started');

  const running = box.run({ format: 1, stages: [
    box.step('tests-a', 'tests', [
      `require('fs').writeFileSync(${JSON.stringify(started)}, '1');`,
      'process.on(\'SIGTERM\', () => process.exit(0));',
      'setInterval(() => {}, 100);',
    ].join('\n')),
    {
      id: 'bundle',
      group: 'build',
      needs: ['tests'],
      argv: [process.execPath, '-e',
        'require("fs").writeFileSync(process.argv[1], "bad")', box.marker]
    },
  ] });

  while (!await fs.stat(started).then(() => true, () => false)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  process.kill(process.pid, 'SIGINT');

  const result = await running;

  assert.equal(result.code, 130);
  assert.equal(result.reason, 130);
  assert.equal(result.outcomes['tests-a']!.status, 'cancelled');
  assert.equal(result.outcomes.bundle!.status, 'cancelled');
  await assert.rejects(fs.stat(box.marker), { code: 'ENOENT' });
  assert.equal((await fs.readdir(box.receiptDir)).length, 1);
});

test('PIPELINE-CANCEL-SETSID: выживший потомок дождётся KILL, чужой процесс не тронут', async (t) => {
  const box = await pipelineFixture(t);
  const started = path.join(box.workDir, 'child-started');
  const grandchildSource = 'process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 100);';
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100);'],
    { stdio: 'ignore' });

  t.after(() => {
    unrelated.kill('SIGKILL');
  });

  const running = box.run({ format: 1, stages: [
    box.step('tests-a', 'tests', [
      `require('fs').writeFileSync(${JSON.stringify(started)}, '1');`,
      `const child = require('child_process').spawn(${JSON.stringify(process.execPath)},`,
      `  ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' });`,
      'child.unref();',
      `require('fs').writeFileSync(${JSON.stringify(path.join(box.workDir, 'grandchild.pid'))},`,
      '  String(child.pid));',
      'setInterval(() => {}, 100);',
    ].join('\n')),
  ] });

  const grandchildPidFile = path.join(box.workDir, 'grandchild.pid');

  while (!await fs.stat(grandchildPidFile).then(() => true, () => false)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  process.kill(process.pid, 'SIGTERM');

  const result = await running;

  assert.equal(result.code, 143);
  assert.equal(result.cleanupConfirmed, true);

  const grandchildPid = Number(await fs.readFile(
    path.join(box.workDir, 'grandchild.pid'), 'utf8'));

  assert.equal(await isAlive(grandchildPid), false);
  assert.equal(await isAlive(unrelated.pid!), true);
});

async function isAlive(pid: number): Promise<boolean> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');

  return Boolean(stat) && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
}

test('PIPELINE-TIMEOUT: превышение стадии даёт 124 и блокирует дальнейшее', async (t) => {
  const box = await pipelineFixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100);'],
    { stdio: 'ignore' });

  t.after(() => {
    unrelated.kill('SIGKILL');
  });

  const result = await box.run({ format: 1, stages: [
    { ...box.step('tests-a', 'tests', 'setInterval(() => {}, 100);'), timeoutMs: 300 },
    box.step('tests-b', 'tests', 'process.exit(0)'),
  ] });

  assert.equal(result.code, 124);
  assert.equal(result.outcomes['tests-a']!.status, 'failed');
  assert.equal(result.outcomes['tests-b']!.status, 'cancelled');
  assert.equal(await isAlive(unrelated.pid!), true);
});

test('PIPELINE-BETWEEN-STAGES: сигнал в паузе между стадиями не теряется', async (t) => {
  const box = await pipelineFixture(t);
  const firstDone = path.join(box.workDir, 'first-done');
  const secondStarted = path.join(box.workDir, 'second-started');
  /**
   * Барьер ждёт файл первого child, прежде чем послать сигнал между стадиями.
   * Проверка отмены не зависит от точного времени запуска следующего процесса.
   */
  const poll = async () => {
    for (;;) {
      if (await fs.stat(firstDone).then(() => true, () => false)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const running = box.run({ format: 1, stages: [
    box.step('tests-a', 'tests', [
      `require('fs').writeFileSync(${JSON.stringify(firstDone)}, '1');`,
      'process.exit(0);',
    ].join('\n')),
    box.step('tests-b', 'tests', [
      `require('fs').writeFileSync(${JSON.stringify(secondStarted)}, '1');`,
      'setInterval(() => {}, 100);',
    ].join('\n')),
    {
      id: 'bundle',
      group: 'build',
      needs: ['tests'],
      argv: [process.execPath, '-e',
        'require("fs").writeFileSync(process.argv[1], "bad")', box.marker]
    },
  ] });

  await poll();
  process.kill(process.pid, 'SIGINT');

  const result = await running;

  assert.equal(result.code, 130);
  await assert.rejects(fs.stat(box.marker), { code: 'ENOENT' });
});

test('PIPELINE-RECEIPTS: повтор пишет новый runId и не перезаписывает failed receipt', async (t) => {
  const box = await pipelineFixture(t);

  const failed = await box.run({ format: 1, stages: [
    box.step('tests-a', 'tests', 'process.exit(9)'),
  ] });
  const succeeded = await box.run({ format: 1, stages: [
    box.step('tests-a', 'tests', 'process.exit(0)'),
  ] });

  const receipts = await fs.readdir(box.receiptDir);

  assert.equal(receipts.length, 2);
  assert.notEqual(failed.runId, succeeded.runId);
  assert.equal(failed.code, 1);
  assert.equal(succeeded.code, 0);

  const failedSaved = JSON.parse(await fs.readFile(
    path.join(box.receiptDir, `pipeline-${failed.runId}.json`), 'utf8'));

  assert.equal(failedSaved.code, 1);
});

test('PIPELINE-RECIPE-DIGEST: изменение рецепта меняет digest', async () => {
  const recipe = decodeRecipe({ format: 1, stages: [
    {
      id: 'a',
      group: 'tests',
      argv: ['true']
    },
  ] });
  const changed = decodeRecipe({ format: 1, stages: [
    {
      id: 'a',
      group: 'tests',
      argv: ['false']
    },
  ] });
  const runner = Buffer.from('runner-bytes');

  assert.equal(recipeDigest(recipe, runner), recipeDigest(recipe, runner));
  assert.notEqual(recipeDigest(recipe, runner), recipeDigest(changed, runner));
});

/** Реальные связи рецепта остаются исполнимыми во всех трёх изолированных scope. */
test('PIPELINE-RECIPE-ORDER: зависимости подготовки не блокируются будущими стадиями', async (t) => {
  const box = await pipelineFixture(t);
  const original = decodeRecipe(JSON.parse(await fs.readFile(
    new URL('../../tools/releaseRecipe.json', import.meta.url), 'utf8')));
  const recipe = decodeRecipe({ ...original, stages: original.stages.map(({ memory: _memory, ...stage }) => ({
    ...stage, argv: [process.execPath, '-e', 'process.exit(0)'],
  })) });

  for (const groups of [['prepare-server', 'prepare-build', 'server'],
    ['prepare-web', 'prepare-build', 'web'], ['prepare-build', 'prepare-web', 'build']]) {
    const result = await runStages({
      recipe,
      groups,
      cwd: box.workDir,
      env: { PATH: process.env.PATH },
      logFile: path.join(box.workDir, groups.at(-1)! + '.log'),
      receiptDir: box.receiptDir,
    });

    assert.equal(result.code, 0, JSON.stringify(result.outcomes));
    assert.equal(result.outcomes['server-browser']!.status, 'success',
      'Изолированный scope должен получить собственный Chromium перед doctor');
    assert.ok(Object.values(result.outcomes).every((outcome) =>
      outcome.status === 'success' || outcome.status === 'skipped'));
  }
});
