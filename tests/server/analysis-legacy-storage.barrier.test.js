import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.ts';
import analysisModule from '../../server/src/modules/analysis/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));

/**
 * Создаёт только root-файлы старого формата и настоящий Analyzer без трекера.
 * Отсутствие start запрещает восстановленной очереди запускать модель в барьере.
 */
async function legacyFixture(t, files) {
  const analysisDir = await mkdtemp(path.join(os.tmpdir(), 'analysis-legacy-barrier-'));

  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(analysisDir, name), bytes);
  }

  let models = 0;
  const analyzer = new Analyzer({
    config: { analysisDir },
    tracker: null,
    factoryState: {},
    executorFor: async () => {
      models += 1;

      throw new Error('Барьер не запускает модель');
    },
    log: null,
  });

  await analyzer._ready;

  const app = require('fastify')();

  app.decorate('pluginEnabled', () => true);
  await app.register(analysisModule, { analyzer });
  t.after(async () => {
    await app.close();
    await rm(analysisDir, { recursive: true, force: true });
  });

  return {
    analyzer,
    app,
    analysisDir,
    models: () => models,
  };
}

test('LEGACY-STORAGE-01: root оценка и уточнения читаются без доски и без перезаписи', async (t) => {
  const files = {
    't42.analysis.json': '{"task":42,"summary":"Старая оценка","questions":[]}\n',
    't42.clarify.md': '## Ответ человека\nСохраняем прежний режим.\n',
  };
  const fx = await legacyFixture(t, files);
  const detail = await fx.app.inject('/api/analysis/42');
  const clarification = await fx.app.inject('/api/tasks/42/clarifications');

  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().analysis.summary, 'Старая оценка');
  assert.equal(clarification.json().text, files['t42.clarify.md']);

  for (const [name, bytes] of Object.entries(files)) {
    assert.equal(await readFile(path.join(fx.analysisDir, name), 'utf8'), bytes);
  }

  assert.equal(fx.models(), 0);
});

test('LEGACY-RECOVERY-01: queued восстановлен, running прерван, модель не запущена', async (t) => {
  const fx = await legacyFixture(t, {
    't42.status.json': JSON.stringify({
      task: 42,
      state: 'queued',
      queuedAt: 1,
    }),
    't43.status.json': JSON.stringify({
      task: 43,
      state: 'running',
      startedAt: 2,
    }),
  });
  const rows = (await fx.app.inject('/api/analysis')).json();

  assert.equal(rows.find((row) => row.task === 42).status.state, 'queued');
  assert.equal(rows.find((row) => row.task === 43).status.state, 'interrupted');
  assert.match((await fx.analyzer.get('43')).status.error, /рестарт/);
  assert.equal(fx.models(), 0);
});
