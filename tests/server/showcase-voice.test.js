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

import {
  canonicalTextOf,
  openVoiceSession,
  unreadableFragments,
  unsupportedDirections,
} from '../../server/src/lib/showcase/voice/contract.ts';
import {
  createStressDictionaryStore,
  dictionaryStresses,
  parseStressDictionary,
} from '../../server/src/lib/showcase/voice/dictionary.ts';
import { mergeStresses } from '../../server/src/lib/showcase/narrationOps.ts';
import { createVoiceRegistry } from '../../server/src/lib/showcase/voice/registry.ts';
import {
  narrationWords,
  parseNarration,
  plainNarration,
} from '../../shared/showcaseNarration.ts';
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

test('нативные метки кандидата optional и проходят через обычную сессию без подмены текста', async () => {
  const input = {
    canonicalText: 'Замок открыт. Замок закрыт.',
    direction: {
      tone: null,
      pace: null,
      emphasis: [],
      pauses: [],
      stresses: [],
    },
    voiceRef: 'anna',
    language: 'ru',
  };
  const options = { outputDir: '/tmp', deadlineMs: 1000, signal: undefined };
  const legacySession = await openVoiceSession(engineStub());
  const [legacy] = await legacySession.synthesize([input], options);

  assert.equal('speechTiming' in legacy, false, 'старый адаптер не обязан выдумывать метки');
  await legacySession.close();

  const speechTiming = {
    source: 'edge',
    words: [
      { text: 'Замок', startMs: 20, endMs: 140 },
      { text: 'Замок', startMs: 300, endMs: 420 },
    ],
    segments: [{ text: 'Замок открыт. Замок закрыт.', startMs: 20, endMs: 600 }],
  };
  let received = null;
  const timedSession = await openVoiceSession(engineStub({
    synthesize: async (candidateInput) => {
      received = candidateInput;

      return {
        temporaryFile: '/tmp/timed.wav',
        format: 'wav',
        sampleRate: 24_000,
        channels: 1,
        engineRequestId: 'edge-request',
        ignoredDirections: [],
        speechTiming,
      };
    },
  }));
  const [timed] = await timedSession.synthesize([input], options);

  assert.deepEqual(received, input, 'метки результата не входят в текст или выбор голоса');
  assert.deepEqual(timed.speechTiming, speechTiming);
  await timedSession.close();
});

test('канонический текст не тащит в синтез разметку ввода', () => {
  assert.equal(
    canonicalTextOf('  Открываем   обзор\nкокпита.  '),
    'Открываем обзор кокпита.',
  );
  assert.equal(canonicalTextOf('Я купил з+амок.'), 'Я купил замок.');
});

test('знак «+» перед гласной — ударение, любой другой «+» — текст', () => {
  const parsed = parseNarration('  Арс+енал и\nз+амок: 2+2, C++ и +Ольга.');

  assert.equal(parsed.text, 'Арсенал и замок: 2+2, C++ и Ольга.');
  // Смещения считаются в каноническом тексте: `at` — начало слова, `vowel` — сдвиг
  // ударной гласной, и вставка `+` в `at + vowel` возвращает знак на место.
  assert.deepEqual(parsed.stresses, [
    { at: 0, vowel: 3 },
    { at: 10, vowel: 1 },
    { at: 28, vowel: 0 },
  ]);

  for (const stress of parsed.stresses) {
    assert.match(parsed.text[stress.at + stress.vowel], /[аеёиоуыэюя]/i);
  }

  assert.equal(plainNarration('Я купил\n  з+амок и 2+2.'), 'Я купил\n  замок и 2+2.');
  // Дефис делит слово: словарная запись «р+азному» ложится и на «по-разному».
  assert.deepEqual(narrationWords('по-разному, да'), [
    { at: 0, word: 'по' },
    { at: 3, word: 'разному' },
    { at: 12, word: 'да' },
  ]);
});

test('нечитаемые обрывки называются словами, а не флагом', () => {
  assert.deepEqual(
    unreadableFragments('Открываем API и Cockpit за 2026 год, v2.', ['latin', 'digits']),
    ['API', 'Cockpit', '2026', 'v2'],
  );
  assert.deepEqual(unreadableFragments('Отчёт за 2026 год и API.', ['digits']), ['2026']);
  assert.deepEqual(unreadableFragments('Отчёт за 2026 год.', undefined), []);
  assert.deepEqual(unreadableFragments('Только кириллица.', ['latin', 'digits']), []);
});

test('словарь ударений: комментарии, регистр, «ё» и негодные строки с причиной', () => {
  const parsed = parseStressDictionary([
    '# слова, где ударение не угадать',
    'дин+амика',
    'ЗАМ+ОК   # замок на двери',
    'ёлк+а',
    '',
    'безударное',
    'дв+а+жды',
    'зам+ок-2',
    'дин+мика',
  ].join('\n'));

  assert.deepEqual(parsed.entries, [
    { word: 'динамика', vowel: 3 },
    { word: 'замок', vowel: 3 },
    { word: 'ёлка', vowel: 3 },
  ]);
  assert.deepEqual(parsed.errors.map((error) => [error.line, error.reason]), [
    [6, 'нет знака ударения «+»'],
    [7, 'нужен ровно один знак «+»'],
    [8, 'слово должно состоять только из русских букв'],
    [9, 'знак «+» должен стоять перед гласной'],
  ]);
});

test('словарь ложится на слова без явного знака, а явный «+» сильнее словаря', () => {
  const { entries } = parseStressDictionary('зам+ок\nдин+амика');
  const parsed = parseNarration('З+амок открыт, Динамика и замок.');
  const fromDictionary = dictionaryStresses(
    parsed.text,
    entries,
    parsed.stresses.map((stress) => stress.at),
  );

  // Первый «замок» помечен человеком и словарём не трогается; «Динамика» в другом
  // регистре и последний «замок» получают ударение из словаря.
  assert.deepEqual(fromDictionary, [{ at: 14, vowel: 3 }, { at: 25, vowel: 3 }]);
  assert.deepEqual(
    mergeStresses(parsed.stresses, fromDictionary, [{ at: 14, vowel: 0 }, { at: 0, vowel: 3 }]),
    [{ at: 0, vowel: 1 }, { at: 14, vowel: 3 }, { at: 25, vowel: 3 }],
    'на слово — одно ударение, старший источник побеждает',
  );
});

test('хранилище словаря: текст сохраняется целиком, записи перечитываются, предел держится', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-dictionary-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const file = path.join(root, 'stress-dictionary.txt');
  const store = createStressDictionaryStore({ file });

  assert.deepEqual(await store.read(), { text: '', entries: [], errors: [] });
  assert.deepEqual(store.entries(), []);

  const saved = await store.save('дин+амика\nплохо\n');

  assert.equal(saved.text, 'дин+амика\nплохо\n', 'негодная строка не выброшена из текста');
  assert.deepEqual(saved.entries, ['дин+амика']);
  assert.equal(saved.errors[0].line, 2);
  assert.deepEqual(store.entries(), [{ word: 'динамика', vowel: 3 }]);

  const reopened = createStressDictionaryStore({ file });

  assert.deepEqual((await reopened.read()).entries, ['дин+амика']);

  await assert.rejects(
    () => store.save('а+а\n'.repeat(20_000)),
    (error) => error.code === 'dictionary_too_long' && error.status === 413,
  );
  assert.deepEqual(store.entries(), [{ word: 'динамика', vowel: 3 }], 'отказ не трогает словарь');
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

test('реестр отдаёт возможности каждого голоса, а неизвестные не додумывает', async () => {
  const registry = createVoiceRegistry([
    engineStub({
      capabilities: (voiceId) => {
        if (voiceId === 'unknown') {
          throw new Error('каталог не дал возможностей');
        }

        return {
          ...engineStub().capabilities(),
          pace: voiceId === 'anna',
          pause: true,
          stress: voiceId === 'anna',
        };
      },
      voices: async () => [
        { id: 'anna', name: 'Анна', language: 'ru', available: true, reason: '' },
        { id: 'boris', name: 'Борис', language: 'ru', available: true, reason: '' },
        { id: 'unknown', name: 'Старый', language: 'ru', available: true, reason: '' },
      ],
    }),
  ]);
  const [status] = await registry.statuses();

  assert.deepEqual(status.voices[0].capabilities, { pace: true, pause: true, stress: true });
  assert.deepEqual(status.voices[1].capabilities, { pace: false, pause: true, stress: false });
  assert.equal('capabilities' in status.voices[2], false, 'отказ остаётся unknown');
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
  assert.deepEqual(
    statuses.map((item) => item.pace),
    [true, true],
    'умеет ли движок менять темп — часть статуса: интерфейс не предлагает лишних ступеней',
  );

  const mute = createVoiceRegistry([engineStub({
    id: 'mute',
    capabilities: () => ({ ...engineStub().capabilities(), pace: false }),
  })]);

  assert.equal((await mute.statuses())[0].pace, false);

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
