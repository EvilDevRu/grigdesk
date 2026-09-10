// Голос: контракт движка, реестр и самопроверка речи.
//
// Проверка речи РЕКОМЕНДАТЕЛЬНАЯ, и её главное свойство — честность: пропущенная
// проверка не должна выглядеть как пройденная, а совпадение слов не должно
// выдаваться за доказательство качества. Отсюда и состав тестов.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { canonicalTextOf, unsupportedDirections } from '../../server/src/lib/showcase/voice/contract.ts';
import { createVoiceRegistry } from '../../server/src/lib/showcase/voice/registry.ts';
import {
  audioStats,
  checkSpeech,
  missingFrom,
  normalizeWords,
} from '../../server/src/lib/showcase/voice/speechCheck.ts';

const run = promisify(execFile);

function engineStub(overrides = {}) {
  return {
    id: 'stub',
    name: 'Двойник движка',
    kind: 'local',
    capabilities: () => ({
      languages: ['ru'],
      tone: false,
      pace: true,
      emphasis: false,
      pause: false,
      stress: false,
      maxChars: 100,
      supportedFormats: ['wav'],
      engineVersion: 'stub-1',
      modelRevision: null,
    }),
    doctor: async () => ({ status: 'ready', reason: 'готов', install: '' }),
    voices: async () => [
      {
        id: 'anna', name: 'anna', language: 'ru', available: true, reason: '',
      },
    ],
    synthesize: async () => ({
      temporaryFile: '/tmp/none.wav',
      format: 'wav',
      sampleRate: 24_000,
      channels: 1,
      engineRequestId: null,
      ignoredDirections: [],
    }),
    ...overrides,
  };
}

async function makeWav(file, { seconds = 1, frequency = 330, volume = '-6dB' } = {}) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}:sample_rate=48000`,
    '-af', `volume=${volume}`,
    '-c:a', 'pcm_s16le', '-ac', '1',
    file,
  ]);

  return file;
}

async function makeSilence(file, seconds = 1) {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${seconds}`,
    '-c:a', 'pcm_s16le',
    file,
  ]);

  return file;
}

test('нейтральные указания переводятся адаптером, а не ядром', () => {
  const capabilities = engineStub().capabilities();
  const ignored = unsupportedDirections(
    {
      tone: 'дружелюбно',
      pace: 'fast',
      emphasis: [{ from: 0, to: 3 }],
      pauses: [{ at: 5, ms: 300 }],
      stresses: [{ at: 7, vowel: 1 }],
    },
    capabilities,
  );

  // Темп движок поддерживает, поэтому его в списке потерянного нет; остальное
  // обязано быть названо словами, а не потеряться молча.
  assert.deepEqual(ignored, ['тон', 'акценты', 'паузы', 'ударения']);
});

test('канонический текст не тащит в синтез разметку ввода', () => {
  assert.equal(
    canonicalTextOf('  Открываем   обзор\nкокпита.  '),
    'Открываем обзор кокпита.',
  );
});

test('реестр показывает недоступный движок с причиной, а не прячет его', async () => {
  const registry = createVoiceRegistry([
    engineStub({
      doctor: async () => ({
        status: 'blocked',
        reason: 'Нет клиента синтеза.',
        install: 'Нужен системный пакет.',
      }),
      voices: async () => [
        {
          id: 'anna',
          name: 'anna',
          language: 'ru',
          available: false,
          reason: 'Нет клиента синтеза.',
        },
      ],
    }),
  ]);
  const statuses = await registry.statuses();

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].doctor.status, 'blocked');
  assert.match(statuses[0].doctor.install, /пакет/);
  assert.equal(statuses[0].voices[0].available, false, 'голос виден, но помечен недоступным');
});

test('упавший doctor не выкидывает движок из списка', async () => {
  const registry = createVoiceRegistry([
    engineStub({
      doctor: async () => {
        throw new Error('движок не отвечает');
      },
    }),
  ]);
  const statuses = await registry.statuses();

  assert.equal(statuses[0].doctor.status, 'unknown');
  assert.match(statuses[0].doctor.reason, /не отвечает/);
});

test('ссылка на голос разбирается строго', () => {
  const registry = createVoiceRegistry([engineStub()]);

  assert.deepEqual(registry.parseVoiceRef('stub:anna'), { engineId: 'stub', voiceId: 'anna' });

  for (const bad of ['anna', 'stub:', ':anna', '']) {
    assert.throws(() => registry.parseVoiceRef(bad), (error) => error.code === 'bad_voice_ref');
  }
});

test('незнакомый движок даёт отказ, а не молчаливую подмену', () => {
  const registry = createVoiceRegistry([engineStub()]);

  assert.throws(
    () => registry.engineOf('elevenlabs'),
    (error) => error.code === 'unknown_voice_engine',
  );
});

test('несколько движков живут рядом и не смешиваются', async () => {
  const local = engineStub();
  const cloud = engineStub({
    id: 'cloud',
    name: 'Облачный двойник',
    kind: 'cloud',
    voices: async () => [
      {
        id: 'nova', name: 'nova', language: 'ru', available: true, reason: '',
      },
    ],
  });
  const registry = createVoiceRegistry([local, cloud]);
  const statuses = await registry.statuses();

  assert.deepEqual(statuses.map((item) => item.id), ['stub', 'cloud']);
  assert.deepEqual(statuses.map((item) => item.kind), ['local', 'cloud']);
  assert.deepEqual(statuses[1].voices.map((item) => item.id), ['nova']);

  // Голос адресуется вместе со своим движком, поэтому одинаковые имена в разных
  // движках не спорят друг с другом.
  assert.equal(registry.engineOf('cloud').name, 'Облачный двойник');
  assert.equal(registry.engineOf('stub').name, 'Двойник движка');
});

test('слова сравниваются по мультимножеству: повтор не покрывает пропуск', () => {
  assert.deepEqual(normalizeWords('Ёлка, ёлка — и ещё раз ёлка!'), ['елка', 'елка', 'и', 'еще', 'раз', 'елка']);
  assert.deepEqual(missingFrom(['не', 'работает'], ['работает']), ['не']);
  assert.deepEqual(missingFrom(['раз', 'раз'], ['раз']), ['раз']);
  assert.deepEqual(missingFrom(['раз', 'два'], ['два', 'раз']), []);
});

test('тишина вместо речи ловится без распознавания', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = await makeSilence(path.join(dir, 'silence.wav'), 1.5);
  const result = await checkSpeech({
    audioFile: file,
    expectedText: 'Открываем обзор кокпита.',
    // Распознавание тут не нужно: пустая дорожка видна по цифрам, и тратить на
    // неё минуту работы модели незачем.
    transcribe: async () => {
      throw new Error('распознавание не должно вызываться на тишине');
    },
  });

  assert.equal(result.status, 'warning');
  assert.match(result.reason, /нет речи/i);
});

test('недоступное распознавание даёт пропуск, а не успех', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = await makeWav(path.join(dir, 'tone.wav'), { seconds: 1.2 });
  const result = await checkSpeech({
    audioFile: file,
    expectedText: 'Открываем обзор кокпита.',
    transcribe: null,
  });

  assert.equal(result.status, 'skipped', 'непроверенное место не красится в зелёный');
  assert.match(result.reason, /послушать самому/);
});

test('сорванное распознавание тоже пропуск, и причина названа', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = await makeWav(path.join(dir, 'tone.wav'), { seconds: 1.2 });
  const result = await checkSpeech({
    audioFile: file,
    expectedText: 'Открываем обзор кокпита.',
    transcribe: async () => {
      throw new Error('модель речи не запущена');
    },
  });

  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /модель речи не запущена/);
});

test('пропущенное слово показывается словом, даже если доля расхождения мала', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = await makeWav(path.join(dir, 'tone.wav'), { seconds: 1.2 });
  const expected = 'Эта настройка не включает запись экрана в разделе презентаций кокпита сейчас';
  const heard = 'Эта настройка включает запись экрана в разделе презентаций кокпита сейчас';
  const result = await checkSpeech({
    audioFile: file,
    expectedText: expected,
    transcribe: async () => heard,
  });

  assert.equal(result.status, 'warning');
  assert.deepEqual(result.missingWords, ['не'], 'одно потерянное «не» меняет смысл целиком');
});

test('совпавшая расшифровка проходит, а перегруз остаётся предупреждением', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  t.after(() => rm(dir, { recursive: true, force: true }));

  const quiet = await makeWav(path.join(dir, 'quiet.wav'), { seconds: 1.2, volume: '-12dB' });
  const passed = await checkSpeech({
    audioFile: quiet,
    expectedText: 'Открываем обзор кокпита.',
    transcribe: async () => 'открываем обзор кокпита',
  });

  assert.equal(passed.status, 'passed');

  // Синус ffmpeg сам по себе тихий (около −18 dB), поэтому фикстуру перегруза
  // приходится усиливать явно: «volume=0dB» не меняет ничего.
  const loud = await makeWav(path.join(dir, 'loud.wav'), { seconds: 1.2, volume: '24dB' });
  const stats = await audioStats(loud);

  assert.ok(stats.peakDb > -0.5, 'фикстура должна упираться в потолок');

  const clipped = await checkSpeech({
    audioFile: loud,
    expectedText: 'Открываем обзор кокпита.',
    transcribe: async () => 'открываем обзор кокпита',
  });

  assert.equal(clipped.status, 'warning');
  assert.match(clipped.loudnessWarning, /перегруз/);
});
