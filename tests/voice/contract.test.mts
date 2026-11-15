import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVoiceText, unsupportedDirections } from '../../voice/src/contract.ts';

test('voice-contract-разбор-ударений', () => {
  const parsed = parseVoiceText('з+амок и зам+ок');

  assert.equal(parsed.canonicalText, 'замок и замок');
  assert.equal(parsed.stresses.length, 2);
});

test('voice-contract-плюс-в-выражении-не-ударение', () => {
  const parsed = parseVoiceText('2+2 и C++');

  assert.equal(parsed.stresses.length, 0);
  assert.equal(parsed.canonicalText, '2+2 и C++');
});

test('voice-contract-unsupported-pace-и-stress', () => {
  const ignored = unsupportedDirections(
    { pace: 'fast', stresses: [{ at: 0, vowel: 1 }] },
    {
      languages: ['ru'],
      pace: false,
      stress: false,
      pause: false,
      tone: false,
      emphasis: false,
      maxChars: 2000,
      formats: ['wav'],
    },
  );

  assert.deepEqual(ignored, ['темп', 'ударения']);
});

test('voice-contract-поддержанное-не-попадает-в-ignored', () => {
  const ignored = unsupportedDirections(
    { pace: 'normal', stresses: [] },
    {
      languages: ['ru'],
      pace: true,
      stress: true,
      pause: false,
      tone: false,
      emphasis: false,
      maxChars: 2000,
      formats: ['wav'],
    },
  );

  assert.deepEqual(ignored, []);
});
