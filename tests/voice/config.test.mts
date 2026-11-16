import assert from 'node:assert/strict';
import test from 'node:test';

import { maskSecret, resolveVoiceConfig } from '../../voice/src/config.ts';

test('voice-config-приоритет-флаг-выше-env', () => {
  const cfg = resolveVoiceConfig(
    { apiKey: 'sk-flag' },
    { GRIGDESK_VOICE_QWEN_API_KEY: 'sk-env', DASHSCOPE_API_KEY: 'sk-dash' },
    '/home/u',
  );

  assert.equal(cfg.qwenApiKey, 'sk-flag');
});

test('voice-config-свой-env-выше-dashscope', () => {
  const cfg = resolveVoiceConfig(
    {},
    { GRIGDESK_VOICE_QWEN_API_KEY: 'sk-env', DASHSCOPE_API_KEY: 'sk-dash' },
    '/home/u',
  );

  assert.equal(cfg.qwenApiKey, 'sk-env');
});

test('voice-config-fallback-dashscope', () => {
  const cfg = resolveVoiceConfig({}, { DASHSCOPE_API_KEY: 'sk-dash' }, '/home/u');

  assert.equal(cfg.qwenApiKey, 'sk-dash');
});

test('voice-config-нет-ключа-null', () => {
  const cfg = resolveVoiceConfig({}, {}, '/home/u');

  assert.equal(cfg.qwenApiKey, null);
});

test('voice-config-каталог-по-умолчанию-и-переопределения', () => {
  assert.equal(resolveVoiceConfig({}, {}, '/home/u').voiceDir, '/home/u/.grigdesk/voice');
  assert.equal(resolveVoiceConfig({ dir: '/tmp/v' }, {}, '/home/u').voiceDir, '/tmp/v');
  assert.equal(
    resolveVoiceConfig({}, { GRIGDESK_VOICE_DIR: '/tmp/e' }, '/home/u').voiceDir,
    '/tmp/e',
  );
});

test('voice-config-base-url-по-умолчанию-и-переопределение', () => {
  assert.equal(
    resolveVoiceConfig({}, {}, '/home/u').qwenBaseUrl,
    'https://dashscope-intl.aliyuncs.com',
  );
  assert.equal(
    resolveVoiceConfig({}, { GRIGDESK_VOICE_QWEN_BASE_URL: 'http://127.0.0.1:1' }, '/home/u')
      .qwenBaseUrl,
    'http://127.0.0.1:1',
  );
});

test('voice-config-маскирование-ключа', () => {
  assert.equal(maskSecret('sk-1234567890ab'), '***ab');
  assert.ok(!maskSecret('sk-1234567890ab').includes('123456'));
  assert.equal(maskSecret(''), '');
});
