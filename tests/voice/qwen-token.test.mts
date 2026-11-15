import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { runVoice } from '../../voice/src/app.ts';
import type { VoiceIO } from '../../voice/src/app.ts';
import { resolveVoiceConfig } from '../../voice/src/config.ts';
import { parseVoiceText } from '../../voice/src/contract.ts';
import { qwenTokenText } from '../../voice/src/engines/qwenTokenText.ts';
import { fixtureRoot, wavBytes } from './helpers.mts';

const KEY = 'sk-sp-synthetic-test-only';
const API = 'https://token-plan.maas.qwencloudapi.com/api/v1/services/audio/tts/SpeechSynthesizer';

interface TokenBody {
  model: string;
  input: {
    text: string;
    voice: string;
    rate: number;
    language_hints: string[];
    instruction: string;
  };
}

interface SeenRequest {
  url: string;
  headers: Headers;
  body: TokenBody | null;
}

/**
 * Проверяет путь CLI до публикации настоящего WAV через реальные Response и файловые операции.
 * Подменён только внешний сервис: фикстура фиксирует каждый адрес, тело и заголовки запроса.
 */
async function fixture(t: TestContext, audio = wavBytes(), status = 200) {
  const root = await fixtureRoot(t);
  const calls: SeenRequest[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: VoiceIO = {
    env: { TOKEN_PLAN_API_KEY: KEY, DASHSCOPE_API_KEY: KEY },
    getHome: () => root,
    scriptPath: async () => {
      throw new Error('Python не нужен облачному движку.');
    },
    readText: async () => null,
    readFile: async (file) => fs.readFile(file),
    writeFile: async (file, value) => fs.writeFile(file, value),
    writeStdout: async (value) => {
      stdout.push(String(value));
    },
    writeStderr: async (value) => {
      stderr.push(value);
    },
    spawn: async () => {
      throw new Error('Облачный WAV должен обрабатываться без дочерних процессов.');
    },
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });

      if (init?.method === 'POST') {
        return new Response(JSON.stringify(status === 200
          ? { output: { audio: { url: 'https://audio.test/sample.wav' } } }
          : { message: `private ${KEY}` }), { status });
      }

      return new Response(new Uint8Array(audio));
    },
  };

  return {
    root,
    calls,
    stdout,
    stderr,
    io,
    output: path.join(root, 'out.wav'),
  };
}

test('voice-token-явный-сервис-проводит-текст-инструкцию-темп-и-атомарно-публикует-WAV', async (t) => {
  const f = await fixture(t);
  const code = await runVoice([
    'generate', '--service', 'qwencloud-token', '--engine', 'qwen',
    '--text', 'Я плач+у за билет в за́мок. На двери зам+ок.',
    '--instruction', 'Последнее слово означает дверной замок.',
    '--language', 'ru', '--pace', 'slow', '--out', f.output,
  ], { version: 'test' }, f.io);

  assert.equal(code, 0, f.stderr.join(''));
  assert.deepEqual(f.calls.map((call) => call.url), [API, 'https://audio.test/sample.wav']);
  assert.equal(f.calls[0]!.headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(f.calls[1]!.headers.get('authorization'), null);

  const body = f.calls[0]!.body;

  assert.ok(body);
  assert.equal(body.model, 'qwen-audio-3.0-tts-plus');
  assert.equal(body.input.text, 'Я плачу́ за билет в за́мок. На двери замо́к.');
  assert.equal(body.input.voice, 'longanhuan_v3.6');
  assert.equal(body.input.rate, 0.85);
  assert.deepEqual(body.input.language_hints, ['ru']);
  assert.match(body.input.instruction, /плачу́/u);
  assert.match(body.input.instruction, /Последнее слово/u);
  assert.deepEqual(await fs.readFile(f.output), wavBytes());

  const report = JSON.parse(f.stdout.join(''));

  assert.equal(report.service, 'qwencloud-token');
  assert.equal(report.model, 'qwen-audio-3.0-tts-plus');
  assert.deepEqual(report.ignoredDirections, []);
  assert.match(report.warnings.join(''), /экспериментальны/u);
  assert.ok(!f.stdout.join('').includes(KEY));
});

test('voice-token-plus-и-Unicode-не-дублируют-ударение-и-не-меняют-арифметический-плюс', () => {
  assert.equal(qwenTokenText(parseVoiceText('плач+у́ за 2+2')), 'плачу́ за 2+2');
});

test('voice-token-сервис-не-угадывается-по-префиксу-ключа', async (t) => {
  const f = await fixture(t);
  const code = await runVoice(['generate', '--engine', 'qwen', '--text', 'привет'],
    { version: 'test' }, f.io);

  assert.equal(code, 1);
  assert.match(f.stderr.join(''), /--service qwencloud-token/u);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.stdout, []);
});

test('voice-token-config-флаг-выше-env-и-подписочный-адрес-не-зависит-от-ключа', () => {
  assert.equal(resolveVoiceConfig({}, { DASHSCOPE_API_KEY: KEY }, '/unused').qwenService, 'model-studio');

  const config = resolveVoiceConfig({ service: 'qwencloud-token' }, {
    GRIGDESK_VOICE_QWEN_SERVICE: 'model-studio', TOKEN_PLAN_API_KEY: KEY,
  }, '/unused');

  assert.equal(config.qwenService, 'qwencloud-token');
  assert.equal(config.qwenApiKey, KEY);
  assert.equal(config.qwenBaseUrl, 'https://token-plan.maas.qwencloudapi.com');
  assert.equal(resolveVoiceConfig({}, {
    GRIGDESK_VOICE_QWEN_SERVICE: 'qwencloud-token',
  }, '/unused').qwenService, 'qwencloud-token');
});

test('voice-token-каталог-описывает-экспериментальный-режим-и-свой-голос-без-сети', async (t) => {
  const f = await fixture(t);

  assert.equal(await runVoice(['models', '--service', 'qwencloud-token', '--json'],
    { version: 'test' }, f.io), 0);

  const models = JSON.parse(f.stdout.pop()!);

  assert.equal(models[0].model, 'qwen-audio-3.0-tts-plus');
  assert.equal(models[0].capabilities.stressMode, 'experimental');
  assert.equal(models[0].capabilities.instruction, true);
  assert.equal(await runVoice(['voices', '--service', 'qwencloud-token', '--engine', 'qwen', '--json'],
    { version: 'test' }, f.io), 0);
  assert.deepEqual(JSON.parse(f.stdout.pop()!).map((voice: { id: string }) => voice.id), ['longanhuan_v3.6']);
  assert.equal(f.calls.length, 0);
});

test('voice-token-потоковый-WAV-нормализуется-без-перекодирования-PCM', async (t) => {
  const original = wavBytes();
  const streaming = Buffer.from(original);

  streaming.writeUInt32LE(0x7fffffbf, 4);
  streaming.writeUInt32LE(0x7fffff9b, 40);

  const f = await fixture(t, streaming);

  assert.equal(await runVoice(['generate', '--service', 'qwencloud-token', '--text', 'привет',
    '--out', f.output], { version: 'test' }, f.io), 0, f.stderr.join(''));
  assert.deepEqual(await fs.readFile(f.output), original);
  assert.deepEqual(await fs.readdir(f.root), ['out.wav']);
});

for (const broken of ['truncated', 'format', 'odd', 'empty'] as const) {
  test(`voice-token-повреждённый-WAV-${broken}-не-заменяет-прежний-файл`, async (t) => {
    let bytes = wavBytes();

    if (broken === 'truncated') {
      bytes.writeUInt32LE(1000, 4);
    } else {
      bytes.writeUInt32LE(0x7fffffbf, 4);
      bytes.writeUInt32LE(0x7fffff9b, 40);

      if (broken === 'format') {
        bytes.writeUInt16LE(24, 34);
      } else {
        bytes = bytes.subarray(0, broken === 'odd' ? 45 : 44);
      }
    }

    const f = await fixture(t, bytes);

    await fs.writeFile(f.output, 'previous');
    assert.equal(await runVoice(['generate', '--service', 'qwencloud-token', '--text', 'привет',
      '--out', f.output], { version: 'test' }, f.io), 1);
    assert.equal(await fs.readFile(f.output, 'utf8'), 'previous');
    assert.deepEqual(await fs.readdir(f.root), ['out.wav']);
    assert.deepEqual(f.stdout, []);
  });
}

for (const status of [401, 500]) {
  test(`voice-token-HTTP-${status}-не-повторяет-POST-не-раскрывает-ключ-и-сохраняет-файл`, async (t) => {
    const f = await fixture(t, wavBytes(), status);

    await fs.writeFile(f.output, 'previous');
    assert.equal(await runVoice(['generate', '--service', 'qwencloud-token', '--text', 'привет',
      '--out', f.output], { version: 'test' }, f.io), 1);
    assert.equal(f.calls.length, 1);
    assert.equal(await fs.readFile(f.output, 'utf8'), 'previous');
    assert.ok(!f.stderr.join('').includes(KEY));
    assert.deepEqual(f.stdout, []);
  });
}

test('voice-token-ошибки-сервиса-голоса-языка-инструкции-и-ключа-до-сети', async (t) => {
  const f = await fixture(t);

  for (const extra of [
    ['--voice', 'Cherry'], ['--language', 'unknown'], ['--instruction', 'а'.repeat(1601)],
    ['--service', 'unknown'], ['--text', 'а'.repeat(2001)],
  ]) {
    const argv = ['generate', '--service', 'qwencloud-token', '--text', 'привет'];
    const existing = argv.indexOf(extra[0]!);

    if (existing >= 0) {
      argv.splice(existing, 2);
    }

    assert.equal(await runVoice([...argv, ...extra], { version: 'test' }, f.io), 2);
  }

  f.io.env = { DASHSCOPE_API_KEY: 'sk-ordinary-not-subscription' };
  assert.equal(await runVoice(['generate', '--service', 'qwencloud-token', '--text', 'привет'],
    { version: 'test' }, f.io), 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.stdout, []);
});
