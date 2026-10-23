import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { requiredApi } from './helpers/menuFixture.mts';

// Вход модели — уже разрешённые веса; часы и состояние процесса заданы тестом явно.
// status завершённого шага даёт весь вес, текущий ограничен 95%, общий успех — 100%.
test('BP-WEIGHTS: неравные веса, переходы, превышение оценки, монотонность и 100 только после успеха',
  async () => {
    const estimate = await requiredApi('cli/buildState.ts', 'estimateBuildProgress');
    const samples = [
      {
        done: 0,
        current: 0,
        elapsed: 0,
        percent: 0,
      },
      {
        done: 0,
        current: 500,
        elapsed: 500,
        percent: 5,
      },
      {
        done: 1,
        current: 0,
        elapsed: 1000,
        percent: 10,
      },
      {
        done: 1,
        current: 4500,
        elapsed: 5500,
        percent: 55,
      },
      {
        done: 1,
        current: 100000,
        elapsed: 101000,
        percent: 95.5,
      },
    ];
    let previousPercent = 0;

    for (const sample of samples) {
      const result = estimate({
        steps: [
          {
            id: 'server.node',
            weightMs: 1000,
            status: sample.done ? 'done' : 'running',
            elapsedMs: sample.done ? 1000 : sample.current,
          },
          {
            id: 'server.build',
            weightMs: 9000,
            status: sample.done ? 'running' : 'pending',
            elapsedMs: sample.done ? sample.current : 0,
          },
        ],
        elapsedMs: sample.elapsed,
        previousPercent,
        succeeded: false,
      });

      assert.ok(Math.abs(result.percent - sample.percent) <= 1, JSON.stringify(result));
      assert.ok(result.percent >= previousPercent && result.percent < 100);
      assert.ok(result.remainingMs >= 0);
      previousPercent = result.percent;
    }

    const stalled = estimate({
      steps: [{
        id: 'server.build',
        weightMs: 9000,
        status: 'running',
        elapsedMs: 1,
      }],
      elapsedMs: 1,
      previousPercent: 80,
      succeeded: false,
    });

    assert.ok(stalled.percent >= 80 && stalled.percent < 100, 'Процент не должен идти назад');

    const steps = [
      {
        id: 'server.node',
        weightMs: 1000,
        status: 'done',
        elapsedMs: 1000,
      },
      {
        id: 'server.build',
        weightMs: 9000,
        status: 'done',
        elapsedMs: 9000,
      },
    ];

    assert.equal(estimate({
      steps,
      elapsedMs: 10000,
      previousPercent,
      succeeded: false,
    }).percent, 99);
    assert.equal(estimate({
      steps,
      elapsedMs: 10000,
      previousPercent,
      succeeded: true,
    }).percent, 100);
  });

test('BP-WEIGHTS: первый запуск использует грубые веса из таблицы плана', async () => {
  const estimate = await requiredApi('cli/buildState.ts', 'estimateBuildProgress');
  const result = estimate({
    steps: [
      {
        id: 'server.node',
        status: 'done',
        elapsedMs: 30000,
      },
      {
        id: 'server.build',
        status: 'running',
        elapsedMs: 120000,
      },
      {
        id: 'server.install',
        status: 'pending',
        elapsedMs: 0,
      },
    ],
    elapsedMs: 150000,
    previousPercent: 0,
    succeeded: false,
  });

  assert.equal(result.percent, 50);
  assert.equal(result.remainingMs, 150000);
});

test('BP-HISTORY: успешные веса по варианту/id, ошибка и INT не переписывают историю', async (t) => {
  const read = await requiredApi('cli/buildLog.ts', 'readBuildTimings');
  const save = await requiredApi('cli/buildLog.ts', 'saveBuildTimings');
  const home = await mkdtemp(path.join(os.tmpdir(), 'ctl-build-history-'));
  const steps = [{ id: 'web.dependencies', durationMs: 1000 }, { id: 'web.build', durationMs: 9000 }];
  const input = {
    dataHome: home,
    variant: 'web',
    ids: steps.map((step) => step.id),
  };

  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await read(input), null);
  await save({
    ...input,
    steps,
    outcome: 'success',
  });
  assert.deepEqual(await read(input), steps);

  const file = path.join(home, 'state/ctl-build-timings.json');
  const bytes = await readFile(file, 'utf8');

  assert.equal(JSON.parse(bytes).version, 1);

  for (const outcome of ['error', 'interrupted']) {
    await save({
      ...input,
      steps: steps.map((step) => ({ ...step, durationMs: 42 })),
      outcome,
    });
    assert.equal(await readFile(file, 'utf8'), bytes);
  }

  assert.equal(await read({ ...input, variant: 'server' }), null);
  assert.equal(await read({ ...input, ids: [...input.ids].reverse() }), null);

  for (const corrupted of ['{', '{"version":999}', bytes.replace('9000', '-9'),
    bytes.replace('9000', '0'), bytes.replace('9000', '1e999')]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, corrupted);
    assert.equal(await read(input), null, corrupted);
  }
});
