// Хранилище общих настроек кокпита: запись обязана быть fail-closed, а чтение — fail-soft.
//
// Файл настроек один на всю установку: в нём лежат и паспорта проектов, и выбор человека.
// Пока запись поверх нечитаемого файла считалась нормой, одна порча тихо превращала
// настройки в умолчания и затирала всё, чего человек не подтверждал заново.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrefsStore, PrefsCorruptedError } from '../../server/src/lib/prefsStore.ts';
import { SPEECH_DEFAULTS } from '../../server/src/lib/speechSettings.ts';

async function withPrefs(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-prefs-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefsPath = path.join(dir, 'prefs.json');
  return { dir, prefsPath, prefs: new PrefsStore({ prefsPath }) };
}

test('write при отсутствующем файле создаёт его патчем поверх DEFAULTS', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);

  prefs.write({ showAllModels: true });
  assert.equal(JSON.parse(await readFile(prefsPath, 'utf8')).showAllModels, true);
  assert.equal(prefs.readStored().showAllModels, true);
});

test('write отклоняет запись при нечитаемом файле и не трогает файл', async (t) => {
  const { dir, prefs, prefsPath } = await withPrefs(t);
  const broken = '{"speech":';

  await writeFile(prefsPath, broken, 'utf8');
  assert.throws(() => prefs.write({ showAllModels: true }), PrefsCorruptedError);
  assert.equal(await readFile(prefsPath, 'utf8'), broken);
  assert.deepEqual((await readdir(dir)).sort(), ['prefs.json']);
});

test('write отклоняет запись, если в файле не объект', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);

  for (const content of ['[]', '"x"', 'null']) {
    await writeFile(prefsPath, content, 'utf8');
    assert.throws(
      () => prefs.write({ showAllModels: true }),
      PrefsCorruptedError,
      `содержимое ${content} обязано отклоняться`,
    );
    assert.equal(await readFile(prefsPath, 'utf8'), content);
  }
});

test('readStored бросает PrefsCorruptedError для не-объекта и SyntaxError для битого JSON', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);

  await writeFile(prefsPath, '[]', 'utf8');
  assert.throws(() => prefs.readStored(), PrefsCorruptedError);

  await writeFile(prefsPath, '{"speech":', 'utf8');
  assert.throws(() => prefs.readStored(), SyntaxError);
});

test('read остаётся fail-soft', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);

  await writeFile(prefsPath, '{"speech":', 'utf8');
  assert.deepEqual(prefs.read().speech, SPEECH_DEFAULTS);
  assert.equal(prefs.read().showAllModels, false);

  await writeFile(prefsPath, '[]', 'utf8');
  assert.deepEqual(prefs.read().speech, SPEECH_DEFAULTS);
});

test('write сохраняет projectsMeta целиком', async (t) => {
  const { prefs } = await withPrefs(t);
  const projectsMeta = {
    schemaVersion: 1,
    migratedAt: '2026-09-22T10:00:00.000Z',
    tombstones: { old: { deletedAt: '2026-09-22T09:00:00.000Z', revision: 3 } },
  };

  prefs.write({ projectsMeta });
  assert.deepEqual(prefs.readStored().projectsMeta, projectsMeta);
  assert.deepEqual(prefs.read().projectsMeta, projectsMeta);
});

test('read даёт projectsMeta по умолчанию: schemaVersion 0, tombstones {}', async (t) => {
  const { prefs } = await withPrefs(t);

  assert.deepEqual(prefs.read().projectsMeta, {
    schemaVersion: 0,
    migratedAt: null,
    tombstones: {},
  });
  assert.deepEqual(prefs.readStored(), {});
});
