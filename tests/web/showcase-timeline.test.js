// Общее расписание сцен ролика: по нему сборка режет mp4, а экран ролика считает,
// с какой секунды начинается сцена. Проверяется, что старт сцены складывается из
// плановых длин предыдущих и что неснятая сцена честно ломает расчёт целиком.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const MODULE = webFile('../shared/plugins/showcase/showcaseTimeline.ts');

function artifact(kind, id, durationMs) {
  return {
    id,
    kind,
    inputHash: 'input',
    contentHash: 'content',
    producerVersion: 'v1',
    durationMs,
    byteSize: 1,
  };
}

function scene(id, order, { audioMs, clipMs } = {}) {
  return {
    id,
    order,
    title: id,
    screenId: 'root',
    startState: null,
    readyCondition: null,
    actions: [],
    narration: '',
    caption: '',
    subtitleText: '',
    direction: {
      tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
    },
    timing: null,
    audioSource: { kind: 'tts', voiceRef: null, artifactId: null },
    audio: audioMs === undefined ? null : artifact('audio', `${id}-audio`, audioMs),
    clip: clipMs === undefined ? null : artifact('clip', `${id}-clip`, clipMs),
    frame: null,
    checks: [],
    stale: false,
  };
}

test('сцена длится до конца речи или записи плюс хвост, а старт следующей — сумма предыдущих', async () => {
  const { planScene, sceneStartsMs, PRE_ROLL_MS, POST_ROLL_MS } = await compileModule(MODULE);

  assert.equal(planScene({ audioMs: 3000, clipMs: 1000 }).totalMs, PRE_ROLL_MS + 3000 + POST_ROLL_MS);
  assert.equal(planScene({ audioMs: 1000, clipMs: 5000 }).totalMs, 5000 + POST_ROLL_MS);

  const starts = sceneStartsMs([
    scene('second', 2, { audioMs: 1000, clipMs: 5000 }),
    scene('first', 1, { audioMs: 3000, clipMs: 1000 }),
    scene('third', 3, { audioMs: 500, clipMs: 500 }),
  ]);

  assert.deepEqual([...starts.entries()], [
    ['first', 0],
    ['second', PRE_ROLL_MS + 3000 + POST_ROLL_MS],
    ['third', PRE_ROLL_MS + 3000 + POST_ROLL_MS + 5000 + POST_ROLL_MS],
  ], 'порядок берётся из сцен, а не из массива');
});

test('сцена без записи или звука делает переходы невозможными целиком', async () => {
  const { sceneStartsMs } = await compileModule(MODULE);

  assert.equal(sceneStartsMs([
    scene('first', 1, { audioMs: 3000, clipMs: 1000 }),
    scene('second', 2, { audioMs: 1000 }),
  ]), null, 'угаданное смещение уводило бы зрителя мимо сцены');
  assert.equal(sceneStartsMs([scene('first', 1, { clipMs: 1000 })]), null);
});
