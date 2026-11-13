// Пригодность модели для чата объявляют данные семейств, а не угадывание в компоненте.
// Таблица покрывает новые версии известных нечат-семейств; неизвестная модель остаётся чатовой.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyQwenModel } from '../../server/src/lib/qwen/modelClassification.ts';

test('известные нечат-семейства Qwen классифицируются с причиной', () => {
  const ids = [
    'wan3.0-video',
    'wan3.0-video-prime',
    'wan2.7-t2v',
    'wan2.7-i2v',
    'wan2.7-r2v',
    'wan2.7-videoedit',
    'wan2.7-image',
    'wan2.7-image-pro',
    'qwen-image-3.0-pro',
    'qwen-audio-3.0-tts-plus',
    'qwen3-tts-flash',
    'qwen3-tts-flash-realtime',
    'cosyvoice-v3',
    'qwen-audio-3.0-asr-flash',
    'qwen-audio-3.0-realtime-plus',
    'qwen3.5-omni-plus-realtime',
    'text-embedding-v4',
    'gte-rerank-v2',
    'happyhorse-1.1-t2v',
  ];

  for (const id of ids) {
    const classification = classifyQwenModel(id);

    assert.ok(classification, `${id} должен быть помечен как нечат`);
    assert.match(classification.reason, /не текстовый чат/u);
  }
});

test('чатовые и неизвестные модели пригодность не теряют', () => {
  const ids = [
    'qwen3.8-max',
    'qwen3.7-plus',
    'qwen3.6-flash',
    'qwen4-max-preview',
    'qwen3-coder-plus',
    'qwen3-coder-next',
    'glm-5.3',
    'deepseek-v4-pro',
    'kimi-k2.5',
    'MiniMax-M2.5',
    'auto',
    'unknown-vendor-model',
  ];

  for (const id of ids) {
    assert.equal(classifyQwenModel(id), null, `${id} остаётся чатовой моделью`);
  }

  assert.equal(classifyQwenModel(''), null);
  assert.equal(classifyQwenModel(undefined), null);
});

test('правило не зависит от регистра и покрывает новые версии семейства', () => {
  assert.ok(classifyQwenModel('WAN9.9-T2V-PLUS'));
  assert.ok(classifyQwenModel('cosyvoice-v99'));
  assert.ok(classifyQwenModel('qwen-image-9.0'));
  assert.ok(classifyQwenModel('wan4.0-video'));
});
