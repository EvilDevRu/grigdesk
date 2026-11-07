// Хранилище роликов: атомарность, редакции и повреждённое состояние.
//
// Ролик собирается долго, а правят его из двух вкладок и параллельно с заданием,
// поэтому проверяется главное: чужая правка не теряется, повреждённый файл не
// становится пустым роликом, а запись чужой версии схемы не выдаётся за поломку.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createScene, createSyncBindings } from '../../server/src/lib/showcase/scenes.ts';
import { createShowcaseStore, newShowcaseId } from '../../server/src/lib/showcase/store.ts';
import { SHOWCASE_SCHEMA_VERSION } from '../../shared/plugins/showcase/showcaseContracts.ts';

const LEGACY_PROJECT_FIXTURE = new URL(
  './fixtures/showcase-project-v1-without-sync.json',
  import.meta.url,
);

async function fixture(t) {
  const showcaseDir = await mkdtemp(path.join(os.tmpdir(), 'showcase-store-'));

  t.after(() => rm(showcaseDir, { recursive: true, force: true }));

  const store = createShowcaseStore({ showcaseDir });

  await store.ensureDirs();

  return { store, showcaseDir };
}

function projectFixture(id) {
  const now = new Date().toISOString();

  return {
    schemaVersion: SHOWCASE_SCHEMA_VERSION,
    id,
    title: 'Ролик о готовой работе',
    revision: 1,
    ref: { kind: 'project', id: 'demo-profile' },
    target: {
      status: 'blocked',
      ref: { kind: 'project', id: 'demo-profile' },
      reason: 'Профиль не объявил контракт презентаций.',
      nextAction: null,
    },
    brief: [],
    scenes: [],
    decisions: [],
    latestFinal: null,
    createdAt: now,
    updatedAt: now,
  };
}

test('правка со старой редакцией отклоняется и не затирает чужую', async (t) => {
  const { store } = await fixture(t);
  const id = newShowcaseId();

  await store.createProject(projectFixture(id));

  const first = await store.updateProject(id, 1, (project) => ({
    ...project,
    title: 'Первая правка',
  }));

  assert.equal(first.revision, 2);

  await assert.rejects(
    () => store.updateProject(id, 1, (project) => ({ ...project, title: 'Вторая вкладка' })),
    (error) => error.code === 'revision_conflict' && error.status === 409,
  );

  const saved = await store.readProject(id);

  assert.equal(saved.title, 'Первая правка');
});

test('одновременные правки выстраиваются в очередь и не теряют друг друга', async (t) => {
  const { store } = await fixture(t);
  const id = newShowcaseId();

  await store.createProject(projectFixture(id));

  // Служебные изменения сервера идут без ожидаемой редакции: они не спорят с
  // человеком, но между собой обязаны выстроиться, а не читать одну версию.
  const results = await Promise.all([
    store.updateProject(id, null, (project) => ({ ...project, brief: [...project.brief, 'раз'] })),
    store.updateProject(id, null, (project) => ({ ...project, brief: [...project.brief, 'два'] })),
    store.updateProject(id, null, (project) => ({ ...project, brief: [...project.brief, 'три'] })),
  ]);

  assert.deepEqual(results.map((item) => item.revision), [2, 3, 4]);

  const saved = await store.readProject(id);

  assert.deepEqual(saved.brief, ['раз', 'два', 'три']);
});

test('повреждённая запись сохраняется для разбора и даёт ошибку чтения', async (t) => {
  const { store, showcaseDir } = await fixture(t);
  const id = newShowcaseId();

  await store.createProject(projectFixture(id));
  await writeFile(path.join(showcaseDir, 'projects', id, 'project.json'), '{ это не json', 'utf8');

  await assert.rejects(
    () => store.readProject(id),
    (error) => error.code === 'corrupted' && /сохранена для разбора/.test(error.message),
  );

  const names = await readdir(path.join(showcaseDir, 'projects', id));

  assert.ok(
    names.some((name) => name.includes('.broken-')),
    'повреждённый файл обязан остаться рядом, а не исчезнуть',
  );
});

test('запись чужой версии схемы — не поломка, а отдельная причина', async (t) => {
  const { store, showcaseDir } = await fixture(t);
  const id = newShowcaseId();
  const project = projectFixture(id);

  await store.createProject(project);
  await writeFile(
    path.join(showcaseDir, 'projects', id, 'project.json'),
    JSON.stringify({ ...project, schemaVersion: SHOWCASE_SCHEMA_VERSION + 1 }),
    'utf8',
  );

  await assert.rejects(
    () => store.readProject(id),
    (error) => error.code === 'schema_mismatch' && error.status === 409,
  );

  const names = await readdir(path.join(showcaseDir, 'projects', id));

  assert.ok(
    !names.some((name) => name.includes('.broken-')),
    'запись другой версии не карантинится: она цела, просто не наша',
  );
});

test('повреждённый ролик не выкидывает из списка остальные', async (t) => {
  const { store, showcaseDir } = await fixture(t);
  const good = newShowcaseId();
  const bad = newShowcaseId();

  await store.createProject(projectFixture(good));
  await store.createProject(projectFixture(bad));
  await writeFile(path.join(showcaseDir, 'projects', bad, 'project.json'), 'нет', 'utf8');

  const listed = await store.listProjects();

  assert.deepEqual(listed.projects.map((item) => item.id), [good]);
  assert.equal(listed.unreadable.length, 1);
  assert.equal(listed.unreadable[0].id, bad);
});

test('повторное создание с тем же идентификатором не затирает начатую работу', async (t) => {
  const { store } = await fixture(t);
  const id = newShowcaseId();

  await store.createProject(projectFixture(id));
  await store.updateProject(id, 1, (project) => ({ ...project, title: 'Уже в работе' }));

  await assert.rejects(
    () => store.createProject(projectFixture(id)),
    (error) => error.code === 'already_exists',
  );

  const saved = await store.readProject(id);

  assert.equal(saved.title, 'Уже в работе');
});

test('запись ролика недоступна посторонним на файловой системе', async (t) => {
  const { store, showcaseDir } = await fixture(t);
  const id = newShowcaseId();

  await store.createProject(projectFixture(id));
  await store.updateProject(id, 1, (project) => ({ ...project, title: 'С правами' }));

  const file = path.join(showcaseDir, 'projects', id, 'project.json');
  const text = await readFile(file, 'utf8');

  assert.match(text, /С правами/);

  const { mode } = await import('node:fs/promises').then((fs) => fs.stat(file));

  assert.equal(mode & 0o077, 0, 'в записи ролика есть отпечатки цели и решения человека');
});

test('старый проект без sync-полей читается, обновляется и не попадает в карантин', async (t) => {
  const { store, showcaseDir } = await fixture(t);
  const legacy = JSON.parse(await readFile(LEGACY_PROJECT_FIXTURE, 'utf8'));

  await store.createProject(legacy);

  const opened = await store.readProject(legacy.id);
  const [scene] = opened.scenes;

  assert.equal(opened.schemaVersion, SHOWCASE_SCHEMA_VERSION);
  assert.equal(scene.syncBindings, null);
  assert.equal(scene.speechTiming, null);
  assert.equal(scene.speechAlignment, null);
  assert.equal(scene.recordingTiming, null);
  assert.equal(scene.narration, 'Открываем з+амок.');
  assert.equal(scene.audioSource.kind, 'recorded');
  assert.equal(scene.audio.id, 'audio-old');
  assert.equal(opened.latestFinal.manifestVersion, null);

  await store.updateProject(legacy.id, opened.revision, (project) => ({
    ...project,
    title: 'Старый ролик после правки',
  }));

  const saved = await store.readProject(legacy.id);
  const names = await readdir(path.join(showcaseDir, 'projects', legacy.id));

  assert.equal(saved.scenes[0].narration, 'Открываем з+амок.');
  assert.equal(saved.scenes[0].audio.contentHash, 'audio-content-old');
  assert.equal(saved.latestFinal.video.id, 'final-old');
  assert.ok(!names.some((name) => name.includes('.broken-')));
});

test('новая сцена сохраняет три cue и обе ссылки измерений после повторной записи', async (t) => {
  const { store } = await fixture(t);
  const id = newShowcaseId();
  const project = projectFixture(id);
  const narration = 'замок открыт, результат готов, рамка видна';
  const actions = [
    { kind: 'click', targetId: 'open' },
    { kind: 'waitVisible', targetId: 'result' },
    { kind: 'highlight', targetId: 'result' },
  ];
  const syncBindings = createSyncBindings(narration, actions, [
    { actionIndex: 0, from: 0, to: 5, kind: 'align-start', origin: 'manual' },
    { actionIndex: 1, from: 14, to: 29, kind: 'ready-before', origin: 'generated' },
    { actionIndex: 2, from: 31, to: 42, kind: 'hold-through', origin: 'manual' },
  ]);
  const scene = createScene(project, {
    title: 'Три состояния',
    screenId: 'overview',
    narration,
    caption: 'Три состояния',
    subtitleText: narration,
    startState: null,
    readyCondition: null,
    actions,
    syncBindings,
  });
  const speechTiming = {
    id: 'speech-timing-1',
    inputHash: 'speech-input',
    contentHash: 'speech-content',
    producerVersion: 'edge-boundaries-1',
    byteSize: 512,
  };
  const recordingTiming = {
    id: 'recording-timing-1',
    inputHash: 'recording-input',
    contentHash: 'recording-content',
    producerVersion: 'recorder-timing-1',
    byteSize: 768,
  };

  await store.createProject({
    ...project,
    scenes: [{ ...scene, speechTiming, recordingTiming }],
  });

  const opened = await store.readProject(id);

  await store.updateProject(id, opened.revision, (current) => ({
    ...current,
    brief: ['Повторная запись JSON'],
  }));

  const saved = await store.readProject(id);
  const [savedScene] = saved.scenes;

  assert.deepEqual(savedScene.syncBindings, syncBindings);
  assert.deepEqual(savedScene.speechTiming, speechTiming);
  assert.deepEqual(savedScene.recordingTiming, recordingTiming);
  assert.equal(savedScene.syncBindings.cues.length, 3);
});

test('retention удаляет только старые недостижимые артефакты', async (t) => {
  const { store } = await fixture(t);
  const id = newShowcaseId();
  const base = projectFixture(id);
  const scene = createScene(base, {
    title: 'Сцена',
    screenId: 'overview',
    narration: 'Текст.',
    caption: 'Текст',
    subtitleText: 'Текст.',
    startState: null,
    readyCondition: null,
    actions: [],
  });
  const audio = {
    id: 'audio-aaaaaaaaaaaa',
    kind: 'audio',
    inputHash: 'input',
    contentHash: 'content',
    producerVersion: 'voice-1',
    durationMs: 1_000,
    byteSize: 4,
  };

  await store.createProject({
    ...base,
    scenes: [{ ...scene, audio }],
  });

  const dir = path.join(store.namesOf(id).scenesDir, scene.id, 'artifacts');
  const kept = path.join(dir, `${audio.id}.wav`);
  const orphan = path.join(dir, 'audio-bbbbbbbbbbbb.wav');
  const unknown = path.join(dir, 'operator-note.txt');

  await mkdir(dir, { recursive: true });
  await writeFile(kept, 'keep');
  await writeFile(orphan, 'old');
  await writeFile(unknown, 'human');
  const old = new Date(Date.now() - 10_000);

  await Promise.all([kept, orphan, unknown].map((file) => utimes(file, old, old)));

  const removed = await store.sweepUnreferencedArtifacts(await store.readProject(id), Date.now());

  assert.equal(removed, 1);
  await access(kept);
  await assert.rejects(() => access(orphan));
  await access(unknown);
});
