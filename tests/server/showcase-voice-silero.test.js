// Адаптер локального голоса Silero: готовность, дикторы и синтез.
//
// Движок подменяется исполняемым файлом с известным поведением: проверяются
// правила адаптера — как он объявляет неготовность, как зовёт движок и что
// делает с его ответом. Одна модель несёт несколько дикторов, и именно они, а не
// файл, должны быть голосами в списке.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSileroEngine,
  PAUSE_TOKEN_END,
  PAUSE_TOKEN_START,
  readInstalledSileroModels,
  sileroMarkup,
} from '../../server/src/lib/showcase/voice/silero.ts';
import { SILERO_VOICES } from '../../server/src/lib/showcase/voice/sileroCatalog.ts';

const DIRECTION = {
  tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
};

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-silero-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Подменённый python: отвечает на проверку модуля, а в резидентном режиме — на
 * каждый запрос заданными фактами по каждой реплике. Аргументы и запросы
 * записываются в файлы — так видно, ЧЕМ адаптер зовёт движок и КАКОЙ текст с
 * каким диктором и темпом ему отдаёт.
 */
async function fakePython(root, {
  facts = '{"durationMs": 2100, "sampleRate": 48000, "channels": 1, "peak": 0.5}',
  hasModule = true,
} = {}) {
  const file = path.join(root, 'python');
  const calls = path.join(root, 'calls.txt');
  const stdin = path.join(root, 'stdin.txt');

  await writeFile(
    file,
    `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
open(${JSON.stringify(calls)}, 'a').write(' '.join(args) + '\\n')
if args[:1] == ['-c']:
    ${hasModule ? 'sys.exit(0)' : "sys.stderr.write('ModuleNotFoundError\\n'); sys.exit(1)"}
for line in sys.stdin:
    if not line.strip():
        continue
    open(${JSON.stringify(stdin)}, 'a').write(line)
    request = json.loads(line)
    results = []
    for item in request['items']:
        open(item['out'], 'wb').write(b'RIFF')
        results.append(json.loads('${facts}'))
    print(json.dumps({'id': request['id'], 'results': results}), flush=True)
`,
    'utf8',
  );
  await chmod(file, 0o755);

  return { python: file, calls, stdin };
}

/** Запросы, ушедшие в движок, по порядку: JSON на строку. */
async function requestsOf(stdin) {
  return (await readFile(stdin, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

async function installModel(modelsDir, overrides = {}) {
  const pack = { ...SILERO_VOICES[0], ...overrides };
  const modelDir = path.join(modelsDir, pack.id);

  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(modelDir, pack.fileName), 'модель', 'utf8');
  await writeFile(path.join(modelDir, 'voice.json'), JSON.stringify({
    schemaVersion: 1,
    id: pack.id,
    name: pack.name,
    language: 'ru',
    file: pack.fileName,
    sampleRate: pack.sampleRate,
    speakers: pack.speakers,
  }), 'utf8');
}

test('каталог Silero закрепляет адрес, размер, сумму и дикторов', () => {
  const pack = SILERO_VOICES[0];

  assert.equal(pack.engineId, 'silero');
  assert.match(pack.url, /^https:\/\/models\.silero\.ai\//);
  assert.match(pack.fileSha256, /^[0-9a-f]{64}$/);
  assert.ok(pack.fileBytes > 10_000_000);
  assert.ok(pack.speakers.length >= 5, 'модель несёт несколько дикторов');
  assert.ok(pack.speakers.every((speaker) => speaker.name && speaker.timbre));
});

test('без установки движок объявляет себя неготовым и называет действие', async () => {
  const engine = createSileroEngine({ python: '', modelsDir: '/nowhere' });
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.install, /кнопкой/);
  assert.deepEqual(await engine.voices(), []);
});

test('окружение без torch названо своей причиной', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, { hasModule: false });
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const doctor = await createSileroEngine({ python, modelsDir }).doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.reason, /torch/);
});

test('голосами становятся дикторы установленной модели', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const models = await readInstalledSileroModels(modelsDir);

  assert.equal(models.length, 1);

  const voices = await createSileroEngine({ python, modelsDir }).voices();

  assert.deepEqual(
    voices.map((voice) => voice.id),
    SILERO_VOICES[0].speakers.map((speaker) => speaker.id),
  );
  assert.ok(voices.every((voice) => voice.available));
  assert.match(voices[0].name, /женский|мужской/, 'тембр назван рядом с именем');
});

test('синтез зовёт движок выбранным диктором и переводит темп', async (t) => {
  const root = await workspace(t);
  const { python, calls, stdin } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const engine = createSileroEngine({ python, modelsDir });
  const candidate = await engine.synthesize(
    {
      canonicalText: 'Фильтр сбрасывается одним нажатием.',
      direction: { ...DIRECTION, pace: 'fast' },
      voiceRef: 'aidar',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(candidate.format, 'wav');
  assert.equal(candidate.sampleRate, 48_000);
  await access(candidate.temporaryFile);

  const argv = await readFile(calls, 'utf8');

  assert.match(argv, /--model .*v5_5_ru\/v5_5_ru\.pt/);
  assert.match(argv, /--serve/);
  assert.doesNotMatch(argv, /Фильтр/, 'реплика не попадает в командную строку');

  const [first] = await requestsOf(stdin);

  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].speaker, 'aidar');
  assert.equal(first.items[0].rate, 'fast');
  assert.equal(first.items[0].out, candidate.temporaryFile);

  await engine.synthesize(
    {
      canonicalText: 'Фильтр сбрасывается одним нажатием.',
      direction: { ...DIRECTION, pace: 'slowest' },
      voiceRef: 'aidar',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  const [, second] = await requestsOf(stdin);

  assert.equal(second.items[0].rate, 'slowest', 'крайняя ступень доходит до скрипта');
});

test('сеанс на задание держит один процесс с моделью на все реплики', async (t) => {
  const root = await workspace(t);
  const { python, calls, stdin } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const session = await createSileroEngine({ python, modelsDir }).openSession();

  assert.equal(session.batch, null, 'Silero читает реплики по одной');

  const candidates = await session.synthesize(
    ['Первая.', 'Вторая.', 'Третья.'].map((canonicalText) => ({
      canonicalText, direction: DIRECTION, voiceRef: 'xenia', language: 'ru',
    })),
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  await session.close();

  assert.equal(candidates.length, 3);
  assert.equal(new Set(candidates.map((item) => item.temporaryFile)).size, 3, 'файлы не совпадают');
  assert.deepEqual(
    (await requestsOf(stdin)).map((request) => request.items.map((item) => item.text)),
    [['Первая.'], ['Вторая.'], ['Третья.']],
    'реплики ушли по одной, в порядке подачи',
  );
  assert.equal(
    (await readFile(calls, 'utf8')).split('\n').filter((line) => line.includes('--serve')).length,
    1,
    'процесс поднят один раз',
  );
});

test('тишина вместо речи — отказ, а не готовый звук', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, {
    facts: '{"durationMs": 2100, "sampleRate": 48000, "channels": 1, "peak": 0.0}',
  });
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  await assert.rejects(
    () => createSileroEngine({ python, modelsDir }).synthesize(
      {
        canonicalText: 'Тихая фраза.',
        direction: DIRECTION,
        voiceRef: 'xenia',
        language: 'ru',
      },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /тишин/.test(error.message),
  );
});

test('две версии модели с теми же дикторами дают один список, а говорит новая', async (t) => {
  const root = await workspace(t);
  const { python, calls } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);
  await installModel(modelsDir, { id: 'v4_ru', name: 'Silero v4', fileName: 'v4_ru.pt' });

  const engine = createSileroEngine({ python, modelsDir });
  const voices = await engine.voices();

  assert.equal(voices.length, SILERO_VOICES[0].speakers.length, 'дикторы не удваиваются');
  assert.equal(engine.capabilities(null).engineVersion, 'silero-v5_5_ru');

  await engine.synthesize(
    {
      canonicalText: 'Говорит новая версия.',
      direction: DIRECTION,
      voiceRef: 'xenia',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.match(await readFile(calls, 'utf8'), /--model .*v5_5_ru\/v5_5_ru\.pt/);
});

test('ударения и паузы уходят движку разметкой, а не теряются', async (t) => {
  const root = await workspace(t);
  const { python, stdin } = await fakePython(root);
  const modelsDir = path.join(root, 'silero');

  await installModel(modelsDir);

  const engine = createSileroEngine({ python, modelsDir });
  const own = engine.capabilities(null);

  assert.equal(own.stress, true);
  assert.equal(own.pause, true);
  assert.deepEqual(own.unreadable, ['latin', 'digits'], 'латиницу и цифры движок не читает');

  const candidate = await engine.synthesize(
    {
      canonicalText: 'Я купил замок. И ещё один замок.',
      direction: {
        ...DIRECTION,
        stresses: [{ at: 8, vowel: 1 }, { at: 26, vowel: 3 }],
        pauses: [{ at: 14, ms: 600 }],
      },
      voiceRef: 'xenia',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.deepEqual(candidate.ignoredDirections, [], 'ударения и паузы применены, а не отброшены');

  const [request] = await requestsOf(stdin);

  assert.equal(
    request.items[0].text,
    `Я купил з+амок.${PAUSE_TOKEN_START}600${PAUSE_TOKEN_END} И ещё один зам+ок.`,
  );
});

test('разметка Silero: вставки с конца, предел паузы и защита от подделки токена', () => {
  const text = `Первая.${PAUSE_TOKEN_START}9${PAUSE_TOKEN_END} Вторая.`;
  const marked = sileroMarkup(text, {
    ...DIRECTION,
    stresses: [{ at: 0, vowel: 4 }],
    pauses: [{ at: 7, ms: 9000 }, { at: 3, ms: 0 }],
  });

  // Чужие символы частного диапазона из текста заменены пробелами, поэтому
  // токен в результате ровно один — тот, что поставил адаптер, и не длиннее 7 с.
  assert.equal(marked.split(PAUSE_TOKEN_START).length - 1, 1);
  assert.match(marked, /^Перв\+ая\.\uE0007000\uE001/u);
  assert.doesNotMatch(marked, /\uE0009\uE001/u, 'подделанный токен не пережил разметку');
});
