import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CREDIT_FORMS } from '../../shared/studio3d/studio3dOperations.ts';
import { parseStudio3d } from '../../shared/studio3d/studio3dContracts.ts';
import { createLibrary } from '../../server/src/lib/studio3d/library.ts';
import { normalizeSearch, searchModels, summarizeModel,
  spendingFor } from '../../server/src/lib/studio3d/search.ts';

test('SR-06 резерв не является неизвестным списанием', () => {
  const groups = spendingFor([{ provider: 'tripo', cost: {
    estimated: 30,
    actual: null,
    free: false,
    unit: CREDIT_FORMS,
    state: 'reserved'
  } }]);
  
  assert.equal(groups[0].unknownCount, 0);
  assert.equal(groups[0].actual, 0);
});

const fileUrl = (modelId, versionId, name) => `/api/studio3d/files/${modelId}/${versionId}/${name}`;

/**
 * Реальная библиотека даёт валидные metadata и цены без живых API или моделей.
 * Подменённые часы делают период и порядок независимыми от длительности теста.
 */
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-studio-search-'));
  let at = Date.parse('2026-10-10T10:00:00Z');
  const library = createLibrary({ dir, now: () => at });

  await library.ensure();
  t.after(async () => {
    await library.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const hero = await library.createModel({
    name: 'Гринев',
    project: 'project-one',
    category: 'character',
    notes: 'Рядом с машиной',
    tags: ['герой']
  });
  const version = await library.addVersion(hero.id, {
    kind: 'animated',
    operation: 'animate',
    provider: 'tripo',
    label: 'Дверь машины',
    params: { prompt: 'Тихая прогулка' },
    task: {
      provider: 'tripo',
      id: 'fixture-task-123',
      type: 'animate_retarget'
    },
    cost: {
      estimated: 30,
      actual: 35,
      free: false,
      unit: CREDIT_FORMS,
      state: 'charged'
    },
  });

  await library.writeVersionFile(hero.id, version.id, 'preview.webp', Buffer.from('fixture'),
    { role: 'preview' });
  await library.writeVersionFile(hero.id, version.id, 'door.glb', Buffer.from('model'), { role: 'model' });

  at = Date.parse('2026-10-11T10:00:00Z');

  const prop = await library.createModel({
    name: 'Дверь',
    project: 'project-two',
    category: 'prop',
    origin: 'file'
  });

  await library.addVersion(prop.id, { kind: 'model' });

  return {
    library,
    hero,
    prop,
    version,
    entries: (await library.listModels()).entries
  };
}

test('SR-01 поиск ё/е и # совпадает по каждому слову, включая task/file', async (t) => {
  const { entries, hero } = await fixture(t);

  assert.equal(normalizeSearch('  ГРИНЁВ  #123  '), 'гринев 123');
  assert.equal(searchModels(entries, { q: 'ГРИНЁВ дверь' }, fileUrl).models[0].id, hero.id);
  assert.equal(searchModels(entries, { q: 'fixture-task-123 door.glb' }, fileUrl).total, 1);
  assert.equal(searchModels(entries, { q: 'Гринев неизвестно' }, fileUrl).total, 0);
});

test('SR-02 фильтры и период пересекаются, все has обязательны', async (t) => {
  const { entries, hero } = await fixture(t);
  const queries = [
    { project: 'project-one' },
    { category: 'character' },
    { has: 'rig,animation' },
    { origin: 'section' },
    { provider: 'tripo' },
    { from: '2026-10-10', to: '2026-10-10T23:59:59Z' },
  ];

  for (const query of queries) {
    assert.deepEqual(searchModels(entries, query, fileUrl).models.map((model) => model.id), [hero.id]);
  }

  assert.equal(searchModels(entries, { project: 'project-two', provider: 'tripo' }, fileUrl).total, 0);
  assert.equal(searchModels(entries, { has: 'rig,parts' }, fileUrl).total, 0);
});

test('SR-03 сортировка и пагинация сохраняют total до среза', async (t) => {
  const { entries, hero, prop } = await fixture(t);

  assert.equal(searchModels(entries, {}, fileUrl).models[0].id, prop.id);
  assert.equal(searchModels(entries, { sort: 'name' }, fileUrl).models[0].id, hero.id);
  assert.equal(searchModels(entries, { sort: 'spent' }, fileUrl).models[0].id, hero.id);

  const page = searchModels(entries, { offset: 1, limit: 1 }, fileUrl);

  assert.equal(page.total, 2);
  assert.deepEqual(page.models.map((model) => model.id), [hero.id]);
});

test('SR-04 сводка учитывает actual/unknown, preview и проходит strict models DTO', async (t) => {
  const { library, hero } = await fixture(t);

  await library.addVersion(hero.id, {
    kind: 'model',
    status: 'unknown',
    provider: 'tripo',
    cost: {
      estimated: 30,
      actual: null,
      free: false,
      unit: CREDIT_FORMS,
      state: 'unknown'
    },
  });

  const entry = await library.readModel(hero.id);
  const summary = summarizeModel(entry.model, entry.versions, fileUrl);
  const decoded = parseStudio3d.models({
    libraryId: library.libraryId,
    models: [summary],
    total: 1,
    broken: []
  });

  assert.equal(decoded.models[0].spent, 35);
  assert.equal(summary.active, 1);
  assert.equal(summary.has.rig, true);
  assert.equal(summary.has.animation, true);
  assert.equal(summary.spending[0].unknownCount, 1);
  assert.equal(summary.spending[0].unknownEstimated, 30);
  assert.match(summary.preview, /preview\.webp$/);
});

test('SR-04 разные единицы не смешиваются и refunded не прибавляет расход', async (t) => {
  const { library, hero } = await fixture(t);
  const unit = {
    one: 'жетон',
    few: 'жетона',
    many: 'жетонов'
  };

  await library.addVersion(hero.id, {
    kind: 'model',
    provider: 'another',
    cost: {
      estimated: 2,
      actual: 0.5,
      free: false,
      unit,
      state: 'charged'
    },
  });
  await library.addVersion(hero.id, {
    kind: 'model',
    provider: 'another',
    cost: {
      estimated: 2,
      actual: 2,
      free: false,
      unit,
      state: 'refunded'
    },
  });

  const entry = await library.readModel(hero.id);
  const summary = summarizeModel(entry.model, entry.versions, fileUrl);

  assert.equal(summary.spent, null);
  assert.equal(summary.spending.length, 2);
  assert.equal(summary.spending.find((group) => group.provider === 'another').actual, 0.5);
  assert.equal(summary.spending.find((group) => group.provider === 'another').refunded, 2);
});
