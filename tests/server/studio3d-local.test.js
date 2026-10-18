import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatPrice } from '../../shared/studio3d/studio3dOperations.ts';
import { inspectGlb } from '../../server/src/lib/studio3d/glb.ts';
import { createLocalStudio } from '../../server/src/lib/studio3d/local.ts';
import { START_CONTEXT } from '../../server/src/lib/studio3d/provider.ts';
import { makeGlb } from './helpers/studio3dGlb.js';

/**
 * Временная папка с моделью-образцом: фигура шире по X, чем по Z, как упрощённый
 * герой в T-позе, смотрящий вдоль Z.
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-studio-local-'));
  const input = path.join(dir, 'hero.glb');

  await fs.writeFile(input, makeGlb({
    triangles: 4,
    size: [2, 0.9, 0.4],
    joints: 3
  }));
  t.after(() => fs.rm(dir, {
    recursive: true,
    force: true
  }));

  return {
    dir,
    input,
    context: {
      ...START_CONTEXT,
      kind: 'rigged',
      format: 'glb',
      stats: inspectGlb(await fs.readFile(input))
    }
  };
}

test('LO-01 помощники бесплатны и объявлены тем же контрактом', async () => {
  const local = createLocalStudio();
  const operations = local.operations(START_CONTEXT).map((entry) => entry.operation);
  const quote = local.quote('rotate', {}, START_CONTEXT);

  assert.deepEqual(operations, ['rotate', 'scale']);
  assert.equal(local.local, true);
  assert.equal(formatPrice(quote.total, local.unit), 'бесплатно');
});

test('LO-02 подсказка поворота опирается на сводку модели', async (t) => {
  const { context } = await fixture(t);
  const field = createLocalStudio().operations(context)[0].fields[0];

  assert.equal(context.stats.facing, 'z');
  assert.match(field.hint, /смотрит вдоль Z/);
});

test('LO-03 поворот на 90° меняет габариты, скелет остаётся', async (t) => {
  const { dir, input, context } = await fixture(t);
  const result = await createLocalStudio().run({
    operation: 'rotate',
    values: { turn: 'y90' },
    inputPath: input,
    context,
    outputDir: path.join(dir, 'v2')
  });
  const stats = inspectGlb(await fs.readFile(path.join(dir, 'v2', result.files[0].name)));

  assert.equal(result.label, 'Поворот на 90° против часовой');
  assert.deepEqual(stats.size, [0.4, 0.9, 2]);
  assert.equal(stats.bones, 3);
});

test('LO-04 рост задаётся в метрах от текущей высоты', async (t) => {
  const { dir, input, context } = await fixture(t);
  const result = await createLocalStudio().run({
    operation: 'scale',
    values: { height: 1.8 },
    inputPath: input,
    context,
    outputDir: path.join(dir, 'v3')
  });
  const stats = inspectGlb(await fs.readFile(path.join(dir, 'v3', 'model.glb')));

  assert.equal(result.label, 'Рост 1,8 м');
  assert.equal(stats.size[1], 1.8);
});

test('LO-05 не GLB и без высоты — понятный отказ до работы', () => {
  const local = createLocalStudio();
  const fbx = local.validate('rotate', { turn: 'y90' }, {
    ...START_CONTEXT,
    format: 'fbx'
  });
  const noSize = local.validate('scale', { height: 1.8 }, {
    ...START_CONTEXT,
    format: 'glb'
  });

  assert.equal(fbx.errors[0].message, 'Помощники работают только с GLB.');
  assert.equal(noSize.errors[0].message, 'Высота модели неизвестна — рост задать нельзя.');
});
