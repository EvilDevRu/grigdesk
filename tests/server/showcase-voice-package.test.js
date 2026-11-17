// Адаптер к пакету voice: возможности из CLI, синтез через generate, ошибки словами.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createPackageEngines,
  insertStresses,
  parseWavHeader,
} from '../../server/src/lib/showcase/voice/packageEngine.ts';

// Минимальный валидный WAV: RIFF/fmt/data, PCM16 mono 24 кГц, 100 отсчётов.
/**
 * Небольшой PCM WAV содержит настоящие RIFF/fmt/data для проверки декодера.
 * Частота и каналы читаются из байтов, а не из слов fake CLI.
 */
function wavBytes() {
  const samples = 100;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

const FAKE_VOICE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const marker = process.env.FAKE_VOICE_MARKER;
fs.appendFileSync(marker + '.argv', JSON.stringify(args) + '\\n');
const cmd = args[0];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (cmd === 'version') { console.log('voice 0.1.0 (fake)'); process.exit(0); }
if (cmd === 'engines') {
  // Реальный CLI отдаёт один настроенный сервис Qwen: fake уважает --service.
  const service = flag('--service') || 'model-studio';
  const qwen = service === 'qwencloud-token'
    ? {
      id: 'qwen',
      name: 'Qwen',
      kind: 'cloud',
      model: 'qwen-audio-3.0-tts-plus',
      service: 'qwencloud-token',
      status: 'blocked',
      reason: 'Нет ключа.',
      install: 'Задайте TOKEN_PLAN_API_KEY.',
    }
    : {
      id: 'qwen',
      name: 'Qwen',
      kind: 'cloud',
      model: 'qwen3-tts-flash',
      service: 'model-studio',
      status: 'ready',
      reason: '',
      install: '',
    };
  console.log(JSON.stringify([
    qwen,
    {
      id: 'piper',
      name: 'Piper',
      kind: 'local',
      model: 'irina',
      service: null,
      status: 'ready',
      reason: '',
      install: '',
    },
    {
      id: 'silero',
      name: 'Silero',
      kind: 'local',
      model: 'v5_5_ru',
      service: null,
      status: 'ready',
      reason: '',
      install: '',
    },
  ]));
  process.exit(0);
}
if (cmd === 'models') {
  const service = flag('--service') || 'model-studio';
  const qwen = service === 'qwencloud-token'
    ? {
      id: 'qwen',
      model: 'qwen-audio-3.0-tts-plus',
      service: 'qwencloud-token',
      capabilities: {
        languages: ['ru'],
        pace: true,
        stress: true,
        stressMode: 'experimental',
        maxChars: 2000,
        formats: ['wav'],
      },
    }
    : {
      id: 'qwen',
      model: 'qwen3-tts-flash',
      service: 'model-studio',
      capabilities: {
        languages: ['ru'],
        pace: false,
        stress: false,
        maxChars: 600,
        formats: ['wav'],
      },
    };
  console.log(JSON.stringify([
    qwen,
    {
      id: 'piper',
      model: 'irina',
      service: null,
      capabilities: {
        languages: ['ru'],
        pace: true,
        stress: false,
        maxChars: 2000,
        formats: ['wav'],
      },
    },
    {
      id: 'silero',
      model: 'v5_5_ru',
      service: null,
      capabilities: {
        languages: ['ru'],
        pace: true,
        stress: true,
        maxChars: 2000,
        formats: ['wav'],
      },
    },
  ]));
  process.exit(0);
}
if (cmd === 'voices') {
  const engine = flag('--engine');
  const voices = engine === 'silero'
    ? [{
      id: 'xenia',
      name: 'Ксения',
      languages: ['ru'],
      available: true,
      reason: '',
      engine,
    }]
    : [{
      id: 'irina',
      name: 'Ирина',
      languages: ['ru'],
      available: true,
      reason: '',
      engine,
    }];
  console.log(JSON.stringify(voices));
  process.exit(0);
}
if (cmd === 'generate') {
  if (fs.existsSync(marker + '.fail')) {
    console.error('Silero не читает: API');
    process.exit(2);
  }
  const out = flag('--out');
  fs.writeFileSync(out, Buffer.from(fs.readFileSync(marker + '.wav')));
  console.log(JSON.stringify({
    engine: flag('--engine'),
    model: 'fake',
    service: flag('--service'),
    voice: flag('--voice'),
    file: out,
    bytes: 244,
    format: 'wav',
    ignoredDirections: [],
    warnings: [],
  }));
  process.exit(0);
}
console.error('Неизвестная команда');
process.exit(2);
`;

/**
 * Временный CLI возвращает раздельные сервисы и пишет реальные argv.
 * Синтез копирует WAV, не обращаясь в облако или к установленным моделям.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-package-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const bin = path.join(root, 'voice');
  const marker = path.join(root, 'marker');

  await writeFile(bin, FAKE_VOICE, 'utf8');
  await chmod(bin, 0o755);
  await writeFile(marker + '.wav', wavBytes());

  const engines = createPackageEngines({
    voiceBin: bin,
    voiceDir: path.join(root, 'data'),
    cloudEnv: () => ({ DASHSCOPE_API_KEY: 'test-key' }),
    env: { ...process.env, FAKE_VOICE_MARKER: marker },
  });

  return {
    root,
    bin,
    marker,
    engines,
  };
}

test('ударения возвращаются в текст знаком плюс справа налево', () => {
  assert.equal(
    insertStresses('замок и арсенал', [{ at: 0, vowel: 1 }, { at: 8, vowel: 3 }]),
    'з+амок и арс+енал',
  );
  assert.equal(insertStresses('без ударений', []), 'без ударений');
});

test('заголовок WAV читается из fmt-чанка', () => {
  assert.deepEqual(parseWavHeader(wavBytes()), { sampleRate: 24000, channels: 1 });
  assert.throws(() => parseWavHeader(Buffer.alloc(10)));
});

test('возможности движков берутся из CLI и различают сервисы Qwen', async (t) => {
  const { engines } = await fixture(t);
  const silero = engines.find((engine) => engine.id === 'silero');
  const token = engines.find((engine) => engine.id === 'qwen-token');
  const studio = engines.find((engine) => engine.id === 'qwen-studio');

  // doctor греет кэш возможностей: синхронный capabilities читает уже прочитанное.
  await silero.doctor();
  await token.doctor();
  await studio.doctor();

  assert.deepEqual(silero.capabilities('xenia').unreadable, ['latin', 'digits']);
  assert.equal(silero.capabilities('xenia').stress, true);
  assert.equal(token.capabilities(null).stressMode, 'experimental');
  assert.equal(studio.capabilities(null).maxChars, 600);
  assert.equal(studio.capabilities(null).pace, false);
});

test('doctor называет причину блокировки из CLI', async (t) => {
  const { engines } = await fixture(t);
  const token = engines.find((engine) => engine.id === 'qwen-token');
  const doctor = await token.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.reason, /Нет ключа/u);
});

test('облачные адаптеры зовут CLI со своим сервисом (находка F03)', async (t) => {
  const { engines, marker } = await fixture(t);
  const token = engines.find((engine) => engine.id === 'qwen-token');
  const studio = engines.find((engine) => engine.id === 'qwen-studio');

  await token.doctor();
  await studio.doctor();

  const calls = (await readFile(marker + '.argv', 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const tokenEngines = calls.find((args) => args[0] === 'engines' && args.includes('qwencloud-token'));
  const studioEngines = calls.find((args) => args[0] === 'engines' && args.includes('model-studio'));

  assert.ok(tokenEngines, 'token-адаптер обязан запросить свой сервис');
  assert.ok(studioEngines, 'studio-адаптер обязан запросить свой сервис');
  assert.equal(token.capabilities(null).stressMode, 'experimental');
  assert.equal(studio.capabilities(null).maxChars, 600);
});

test('синтез зовёт generate с разметкой ударений и темпом и отдаёт WAV-кандидат', async (t) => {
  const { engines, marker } = await fixture(t);
  const silero = engines.find((engine) => engine.id === 'silero');
  const outDir = path.join(path.dirname(marker), 'out');

  await mkdir(outDir, { recursive: true });

  const candidate = await silero.synthesize(
    {
      canonicalText: 'замок',
      direction: {
        tone: null,
        pace: 'slow',
        emphasis: [],
        pauses: [],
        stresses: [{ at: 0, vowel: 1 }],
      },
      voiceRef: 'xenia',
      language: 'ru',
    },
    { deadlineMs: 10_000, outputDir: outDir },
  );

  assert.equal(candidate.format, 'wav');
  assert.equal(candidate.sampleRate, 24000);
  assert.equal(candidate.channels, 1);

  const argv = JSON.parse((await readFile(marker + '.argv', 'utf8')).trim().split('\n').at(-1));

  assert.equal(argv[0], 'generate');
  assert.equal(argv[argv.indexOf('--engine') + 1], 'silero');
  assert.equal(argv[argv.indexOf('--voice') + 1], 'xenia');
  assert.equal(argv[argv.indexOf('--text') + 1], 'з+амок');
  assert.equal(argv[argv.indexOf('--pace') + 1], 'slow');
  assert.deepEqual(candidate.ignoredDirections, []);
});

test('отказ CLI приходит словами и без повтора', async (t) => {
  const { engines, marker } = await fixture(t);
  const silero = engines.find((engine) => engine.id === 'silero');

  await writeFile(marker + '.fail', '1');

  await assert.rejects(
    () => silero.synthesize(
      {
        canonicalText: 'API',
        direction: {
          tone: null,
          pace: null,
          emphasis: [],
          pauses: [],
          stresses: [],
        },
        voiceRef: 'xenia',
        language: 'ru',
      },
      { deadlineMs: 10_000, outputDir: path.dirname(marker) },
    ),
    (error) => /не читает/u.test(error.message),
  );

  const calls = (await readFile(marker + '.argv', 'utf8')).trim().split('\n')
    .filter((line) => JSON.parse(line)[0] === 'generate');

  assert.equal(calls.length, 1);
});
