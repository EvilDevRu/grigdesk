// Адаптация реплик под движок: текст новый, действия и порядок прежние.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAdaptNarrationPrompt } from '../../server/src/lib/showcase/script/prompt.ts';
import { parseAdaptReply } from '../../server/src/lib/showcase/script/writer.ts';

const SCENES = [
  {
    id: 's1',
    title: 'Обзор',
    narration: 'Открываем обзор 2026.',
    subtitleText: 'Обзор 2026.',
  },
  {
    id: 's2',
    title: 'Фильтр',
    narration: 'Включаем фильтр API.',
    subtitleText: 'Фильтр API.',
  },
];

const RULES = {
  engineName: 'Silero',
  stress: true,
  stressExperimental: false,
  pace: true,
  maxChars: 400,
  unreadable: ['latin', 'digits'],
  dictionary: [],
};

test('промпт адаптации просит только текст и правила движка', () => {
  const prompt = buildAdaptNarrationPrompt(SCENES, RULES);

  assert.match(prompt, /"narration"/u);
  assert.match(prompt, /"subtitleText"/u);
  assert.match(prompt, /не меняй действия/u);
  assert.match(prompt, /цифры и латиницу пиши русскими словами/u);
  assert.match(prompt, /<scene>/u);
});

test('ответ адаптации разбирается строго по одной записи на сцену', () => {
  const reply = JSON.stringify({
    scenes: [
      {
        sceneId: 's1',
        narration: 'Открываем обзор две тысячи двадцать шесть.',
        subtitleText: 'Обзор.',
      },
      {
        sceneId: 's2',
        narration: 'Включаем фильтр.',
        subtitleText: 'Фильтр.',
      },
    ],
  });
  const parsed = parseAdaptReply(reply, SCENES);

  assert.equal(parsed.problem, null);
  assert.equal(parsed.scenes?.get('s1')?.narration, 'Открываем обзор две тысячи двадцать шесть.');

  const dup = JSON.stringify({
    scenes: [
      {
        sceneId: 's1',
        narration: 'а',
        subtitleText: 'а',
      },
      {
        sceneId: 's1',
        narration: 'б',
        subtitleText: 'б',
      },
    ],
  });

  assert.equal(parseAdaptReply(dup, SCENES).scenes, null);
  assert.equal(parseAdaptReply('не json', SCENES).scenes, null);

  const long = JSON.stringify({
    scenes: [
      {
        sceneId: 's1',
        narration: 'д'.repeat(401),
        subtitleText: 'а',
      },
      {
        sceneId: 's2',
        narration: 'б',
        subtitleText: 'б',
      },
    ],
  });

  assert.equal(parseAdaptReply(long, SCENES).scenes, null);
});

// Импорты теста (находка R3-R3-A5):
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createShowcaseStore } from '../../server/src/lib/showcase/store.ts';
import { createScene } from '../../server/src/lib/showcase/scenes.ts';
import { createScriptOps } from '../../server/src/lib/showcase/scriptOps.ts';

/**
 * Реальные store и scriptOps отделены от модели только очередью JSON-ответов.
 * Сцены TTS и записанного звука позволяют проверить сохранение авторского текста.
 */
async function adaptFixture(t, overrideReplies = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-adapt-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const store = createShowcaseStore({ showcaseDir: root });

  await store.ensureDirs();

  const project = {
    schemaVersion: 2,
    id: 'abcdef1234',
    title: 'Ролик',
    revision: 1,
    ref: null,
    target: null,
    voiceRef: 'silero:xenia',
    pace: null,
    brief: ['Показать фильтр'],
    scenes: [
      {
        ...createScene({ scenes: [], voiceRef: 'silero:xenia' }, {
          title: 'Обзор',
          screenId: 'root',
          narration: 'Открываем обзор 2026.',
          caption: 'Обзор',
          subtitleText: 'Обзор 2026.',
          actions: [],
          startState: null,
          readyCondition: null,
        }),
        order: 1,
      },
      {
        ...createScene({ scenes: [], voiceRef: 'silero:xenia' }, {
          title: 'Запись',
          screenId: 'root',
          narration: 'Авторский текст записи.',
          caption: 'Запись',
          subtitleText: 'Авторский текст.',
          actions: [],
          startState: null,
          readyCondition: null,
        }),
        order: 2,
        audioSource: {
          kind: 'recorded',
          voiceRef: null,
          artifactId: 'rec1',
        },
      },
    ],
    scriptGaps: [],
    scriptMapRevision: null,
    scriptProofHash: null,
    source: null,
    briefSource: null,
    scriptSource: null,
    decisions: [],
    latestFinal: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await store.createProject(project);

  const replies = overrideReplies ?? [
    JSON.stringify({
      scenes: [{
        sceneId: project.scenes[0].id,
        narration: 'Открываем обзор две тысячи двадцать шесть.',
        subtitleText: 'Обзор.',
      }]
    }),
    // generateBindings строит привязки по ВСЕМ сценам (включая recorded) и требует
    // ровно по записи на сцену — ответ перечисляет обе (находка B14).
    JSON.stringify({
      scenes: [
        { sceneId: project.scenes[0].id, bindings: [] },
        { sceneId: project.scenes[1].id, bindings: [] },
      ]
    }),
  ];
  let call = 0;
  const ops = createScriptOps({
    assertEnabled: () => { },
    broadcast: () => { },
    limits: () => ({ maxScenes: 20 }),
    readProject: async (id) => store.readProject(id),
    store,
    targets: { selectedInternalScope: async () => ({ screens: [] }) },
    acquireTargetLease: async () => null,
    resolveScriptModel: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'claude-opus-5' },
      executor: { runUntrusted: async () => replies[call++] ?? replies.at(-1) },
    }),
    scriptModelRef: () => null,
    executorConfig: () => ({}),
    providerSettings: () => ({}),
    taskDetails: null,
    voices: null,
    defaultVoiceRef: null,
    stressDictionary: null,
    publish: (p) => p,
  });

  return {
    store,
    project,
    ops,
  };
}

test('адаптация меняет текст tts-сцен, действия и recorded-сцены не трогает', async (t) => {
  const { project, ops } = await adaptFixture(t);
  const saved = await ops.adaptNarration(project.id);
  const tts = saved.scenes.find((scene) => scene.order === 1);
  const recorded = saved.scenes.find((scene) => scene.order === 2);

  assert.equal(tts.narration, 'Открываем обзор две тысячи двадцать шесть.');
  assert.deepEqual(tts.actions, project.scenes[0].actions);
  assert.equal(recorded.narration, 'Авторский текст записи.');
  assert.equal(recorded.subtitleText, 'Авторский текст.');
  assert.deepEqual(recorded.pronunciationOverrides ?? [], []);
});


test('негодный ответ адаптации не меняет сохранённую редакцию', async (t) => {
  const { project, ops, store } = await adaptFixture(t, ['не json', 'тоже не json']);

  await assert.rejects(() => ops.adaptNarration(project.id), (error) => error.code === 'model_reply_invalid');
  assert.equal((await store.readProject(project.id)).revision, project.revision);
  assert.deepEqual((await store.readProject(project.id)).scenes.map((scene) => scene.narration),
    project.scenes.map((scene) => scene.narration));
});
