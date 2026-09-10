// Зависимости артефактов: что именно устаревает от каждой правки.
//
// Это главный контракт раздела: собрать ролик заново целиком легко, а вот не
// пересобирать лишнего — то, ради чего свежесть считается хешами входов. Каждая
// проверка здесь отвечает на вопрос «что изменится, если поправить вот это».
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  audioInputHash,
  clipInputHash,
  finalInputHash,
  finalIsCurrent,
  sceneFreshness,
} from '../../server/src/lib/showcase/artifacts.ts';

const INPUTS = {
  targetFingerprint: 'target-1',
  policyRevision: 'policy-1',
  dataRevision: 'data-1',
  style: {
    width: 1920,
    height: 1080,
    fps: 30,
    theme: 'dark',
    locale: 'ru-RU',
    burnSubtitles: false,
  },
  versions: {
    recorder: 'recorder-1',
    voice: 'voice-1',
    assembler: 'assembler-1',
  },
};

function artifact(kind, inputHash, contentHash = `${kind}-content`) {
  return {
    id: `${kind}-0123456789ab`,
    kind,
    inputHash,
    contentHash,
    producerVersion: 'v1',
    durationMs: 3000,
    byteSize: 1024,
  };
}

function sceneFixture(overrides = {}) {
  const scene = {
    id: 'scene-1',
    order: 1,
    title: 'Обзор',
    screenId: 'overview',
    startState: null,
    readyCondition: null,
    actions: [{ kind: 'hover', targetId: 'run' }],
    narration: 'Открываем обзор кокпита.',
    caption: 'Обзор',
    subtitleText: 'Открываем обзор кокпита.',
    direction: {
      tone: null,
      pace: null,
      emphasis: [],
      pauses: [],
      stresses: [],
    },
    timing: null,
    audioSource: { kind: 'tts', voiceRef: 'voice-a', artifactId: null },
    audio: null,
    clip: null,
    frame: null,
    checks: [],
    stale: true,
    ...overrides,
  };

  return {
    ...scene,
    audio: scene.audio ?? artifact('audio', audioInputHash(scene, INPUTS)),
    clip: scene.clip ?? artifact('clip', clipInputHash(scene, INPUTS)),
  };
}

test('правка фразы старит звук сцены, но не её клип', () => {
  const scene = sceneFixture();
  const edited = { ...scene, narration: 'Открываем обзор и запускаем разбор.' };

  assert.equal(sceneFreshness(scene, INPUTS).audio, true);
  assert.equal(sceneFreshness(edited, INPUTS).audio, false);
  assert.equal(sceneFreshness(edited, INPUTS).clip, true);
});

test('правка действий старит клип, но не звук', () => {
  const scene = sceneFixture();
  const edited = { ...scene, actions: [{ kind: 'scroll', targetId: null, delta: 400 }] };

  assert.equal(sceneFreshness(edited, INPUTS).clip, false);
  assert.equal(sceneFreshness(edited, INPUTS).audio, true);
});

test('подпись и субтитр не старят ни звук, ни клип', () => {
  const scene = sceneFixture();
  const edited = { ...scene, caption: 'Другая подпись', subtitleText: 'Другой субтитр' };
  const fresh = sceneFreshness(edited, INPUTS);

  assert.equal(fresh.audio, true);
  assert.equal(fresh.clip, true);
});

test('загруженную запись правка текста не старит', () => {
  const recorded = sceneFixture({
    audioSource: { kind: 'recorded', voiceRef: null, artifactId: 'audio-0123456789ab' },
    audio: artifact('audio', 'content-of-file', 'content-of-file'),
  });
  const edited = { ...recorded, narration: 'Совсем другой текст' };

  assert.equal(sceneFreshness(recorded, INPUTS).audio, true);
  assert.equal(
    sceneFreshness(edited, INPUTS).audio,
    true,
    'переозвучивать импортированный звук нельзя, значит и старить его текстом — тоже',
  );
});

test('смена цели или ревизии данных старит клип, но не звук', () => {
  const scene = sceneFixture();

  for (const changed of [
    { ...INPUTS, targetFingerprint: 'target-2' },
    { ...INPUTS, policyRevision: 'policy-2' },
    { ...INPUTS, dataRevision: 'data-2' },
  ]) {
    assert.equal(sceneFreshness(scene, changed).clip, false);
    assert.equal(sceneFreshness(scene, changed).audio, true);
  }
});

test('смена версии браузера старит клипы, версия голоса — звук', () => {
  const scene = sceneFixture();
  const newRecorder = { ...INPUTS, versions: { ...INPUTS.versions, recorder: 'recorder-2' } };
  const newVoice = { ...INPUTS, versions: { ...INPUTS.versions, voice: 'voice-2' } };

  assert.equal(sceneFreshness(scene, newRecorder).clip, false);
  assert.equal(sceneFreshness(scene, newRecorder).audio, true);
  assert.equal(sceneFreshness(scene, newVoice).audio, false);
  assert.equal(sceneFreshness(scene, newVoice).clip, true);
});

test('размер кадра старит клип: это другая картинка из тех же действий', () => {
  const scene = sceneFixture();
  const smaller = { ...INPUTS, style: { ...INPUTS.style, width: 1280, height: 720 } };

  assert.equal(sceneFreshness(scene, smaller).clip, false);
});

test('перестановка сцен не трогает их артефакты, но меняет итог', () => {
  const first = sceneFixture({ id: 'scene-1', order: 1 });
  const second = sceneFixture({ id: 'scene-2', order: 2, narration: 'Вторая сцена.' });
  const project = {
    scenes: [first, second],
    latestFinal: null,
  };
  const swapped = {
    scenes: [{ ...first, order: 2 }, { ...second, order: 1 }],
    latestFinal: null,
  };

  assert.equal(sceneFreshness(first, INPUTS).stale, false);
  assert.equal(sceneFreshness(second, INPUTS).stale, false);
  assert.notEqual(
    finalInputHash(project, INPUTS),
    finalInputHash(swapped, INPUTS),
    'порядок сцен обязан менять итог: у субтитров меняются абсолютные таймкоды',
  );
});

test('собранный ролик перестаёт быть актуальным после правки сцены', () => {
  const scene = sceneFixture();
  const project = { scenes: [scene], latestFinal: null };
  const built = {
    ...project,
    latestFinal: {
      video: artifact('final', finalInputHash(project, INPUTS)),
      subtitles: null,
      manifestId: 'manifest',
      builtAt: new Date().toISOString(),
      current: true,
    },
  };

  assert.equal(finalIsCurrent(built, INPUTS), true);

  const edited = {
    ...built,
    scenes: [{ ...scene, audio: artifact('audio', 'other-hash', 'other-content') }],
  };

  assert.equal(
    finalIsCurrent(edited, INPUTS),
    false,
    'старый файл можно посмотреть, но выдавать его за актуальный нельзя',
  );
});

test('одинаковая длина звука при другом содержимом всё равно меняет итог', () => {
  const scene = sceneFixture();
  const project = { scenes: [scene], latestFinal: null };
  const sameDuration = {
    scenes: [{
      ...scene,
      audio: { ...scene.audio, contentHash: 'другой-звук-той-же-длины' },
    }],
    latestFinal: null,
  };

  assert.notEqual(finalInputHash(project, INPUTS), finalInputHash(sameDuration, INPUTS));
});

test('правка соседней сцены не старит артефакты этой', () => {
  const first = sceneFixture({ id: 'scene-1', order: 1 });
  const second = sceneFixture({ id: 'scene-2', order: 2, narration: 'Вторая сцена.' });
  const editedSecond = { ...second, narration: 'Вторая сцена, поправленная.' };

  assert.equal(sceneFreshness(first, INPUTS).stale, false);
  assert.equal(sceneFreshness(editedSecond, INPUTS).audio, false);
  assert.equal(
    sceneFreshness(first, INPUTS).audio,
    true,
    'соседи независимы: иначе правка одной фразы стоила бы переозвучки всего ролика',
  );
});
