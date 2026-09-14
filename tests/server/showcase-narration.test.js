// Ударения и защита текста на пути озвучки: от текста сцены до stdin движка.
//
// Движок подменён исполняемым файлом, который сохраняет полученный текст: так
// видно, что знак «+» из сцены и запись словаря доехали до движка разметкой, а
// субтитр и проверка речи их не получили. Здесь же — отказ до задания на тексте,
// который движок не прочитает, и устаревание звука после правки словаря.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { audioInputHash } from '../../server/src/lib/showcase/artifacts.ts';
import { createNarrationOps, takeBatch } from '../../server/src/lib/showcase/narrationOps.ts';
import { createShowcaseService } from '../../server/src/lib/showcase/service.ts';
import {
  publishSpeechTiming,
  readSpeechTiming,
  SPEECH_TIMING_END_TOLERANCE_MS,
  SPEECH_TIMING_PRODUCER_VERSION,
  speechTimingInputHash,
} from '../../server/src/lib/showcase/syncStore.ts';
import { QWEN_VOICES } from '../../server/src/lib/showcase/voice/qwenCatalog.ts';
import { createVoiceRegistry } from '../../server/src/lib/showcase/voice/registry.ts';
import {
  alignmentToSource,
  createPronunciationOverrides,
  prepareVoiceText,
} from '../../server/src/lib/showcase/voice/preparation.ts';
import { SILERO_VOICES } from '../../server/src/lib/showcase/voice/sileroCatalog.ts';
import { parseNarration } from '../../shared/showcaseNarration.ts';

const run = promisify(execFile);

test('канонический текст задаёт UTF-16 координаты после ударений, пробелов и emoji', () => {
  const parsed = parseNarration('з+амок  открыт\n😀 замок и ёлка; 2+2.');
  const occurrences = [...parsed.text.matchAll(/замок/giu)].map((match) => match.index);

  assert.equal(parsed.text, 'замок открыт 😀 замок и ёлка; 2+2.');
  assert.deepEqual(parsed.stresses, [{ at: 0, vowel: 1 }]);
  assert.deepEqual(occurrences, [0, 16], 'повторы различаются индексом, emoji занимает две позиции');
});

test('явное произношение меняет только голосовую строку и переводит диапазоны обратно', () => {
  const narration = 'Слово замок рядом с 😀 и ёлкой.';
  const canonical = parseNarration(narration).text;
  const from = canonical.indexOf('замок');
  const voiceRef = 'fixture:voice';
  const overrides = createPronunciationOverrides(narration, [{
    from,
    to: from + 'замок'.length,
    pronunciation: 'за\u0301мок',
    voiceRef,
  }]);
  const prepared = prepareVoiceText({
    scene: {
      narration,
      pronunciationOverrides: overrides,
      direction: {
        tone: null,
        pace: 'fast',
        emphasis: [{ from, to: from + 'замок'.length }],
        pauses: [{ at: from + 'замок'.length, ms: 250 }],
        stresses: [],
      },
    },
    voiceRef,
    // «е» не подменяет «ё»; применяется только точная словарная форма.
    stressDictionary: [
      { word: 'елкой', vowel: 0 },
      { word: 'ёлкой', vowel: 0 },
    ],
  });
  const spokenFrom = prepared.spokenText.indexOf('за\u0301мок');
  const spokenTo = spokenFrom + 'за\u0301мок'.length;

  assert.equal(prepared.sourceText, canonical);
  assert.equal(prepared.spokenText, 'Слово за\u0301мок рядом с 😀 и ёлкой.');
  assert.deepEqual(prepared.direction.emphasis, [{ from: spokenFrom, to: spokenTo }]);
  assert.deepEqual(prepared.direction.pauses, [{ at: spokenTo, ms: 250 }]);
  assert.deepEqual(prepared.dictionaryStresses, [{
    at: prepared.spokenText.indexOf('ёлкой'),
    vowel: 0,
  }]);

  const sourceAlignment = alignmentToSource({
    canonicalText: prepared.spokenText,
    durationMs: 800,
    quality: 'word-exact',
    spans: [{
      from: spokenFrom,
      to: spokenTo,
      startMs: 100,
      endMs: 700,
      precision: 'word',
    }],
    phrases: [{ id: 'phrase-1', from: spokenFrom, to: spokenTo, startMs: 100, endMs: 700 }],
    safePauses: [{ id: 'pause-1', textAt: spokenTo, atMs: 720, quietFromMs: 700, quietToMs: 740 }],
    reason: 'Тестовая точная шкала.',
  }, prepared);

  assert.deepEqual(
    sourceAlignment.spans.map(({ from: start, to }) => ({ from: start, to })),
    [{ from, to: from + 'замок'.length }],
  );
  assert.equal(sourceAlignment.canonicalText, canonical);
  assert.match(sourceAlignment.reason, /явной карте произношения/);
});

test('диапазоны произношения не режут emoji и не пересекаются для одного голоса', () => {
  const narration = '😀 замок';
  const from = parseNarration(narration).text.indexOf('замок');

  assert.throws(
    () => createPronunciationOverrides(narration, [{
      from: 1,
      to: 2,
      pronunciation: 'смайл',
      voiceRef: 'fixture:voice',
    }]),
    (error) => error.code === 'bad_pronunciation_overrides' && /Unicode/.test(error.message),
  );
  assert.throws(
    () => createPronunciationOverrides(narration, [
      { from, to: from + 4, pronunciation: 'за', voiceRef: 'fixture:voice' },
      { from: from + 2, to: from + 5, pronunciation: 'мок', voiceRef: 'fixture:voice' },
    ]),
    (error) => error.code === 'bad_pronunciation_overrides' && /пересекается/.test(error.message),
  );

  assert.doesNotThrow(() => createPronunciationOverrides(narration, [
    { from, to: from + 5, pronunciation: 'з+амок', voiceRef: 'fixture:first' },
    { from, to: from + 5, pronunciation: 'зам+ок', voiceRef: 'fixture:second' },
  ]));
});

test('русский корпус сохраняет разные контекстные ударения без глобальной подмены', () => {
  const parsed = parseNarration('з+амок и зам+ок; м+уки и мук+и; звон+ит; ёлка и елка');

  assert.equal(parsed.text, 'замок и замок; муки и муки; звонит; ёлка и елка');
  assert.deepEqual(
    parsed.stresses.map((stress) => parsed.text.slice(stress.at, stress.at + 6)),
    ['замок ', 'замок;', 'муки и', 'муки; ', 'звонит'],
  );
  assert.match(parsed.text, /ёлка и елка$/, 'ё не восстанавливается из е автоматически');
});

const SCREENS = {
  version: 1,
  screens: [
    {
      id: 'overview',
      title: 'Обзор',
      path: '/',
      readySelector: 'body',
      elements: [],
    },
  ],
};

/**
 * Короткий настоящий WAV для подменённых движков: проверка речи считает его
 * показатели через ffmpeg, и пустышка сорвала бы задание.
 */
async function sampleWave(root) {
  const wav = path.join(root, 'speech.wav');

  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.5:sample_rate=48000',
    '-af', 'volume=-6dB',
    '-c:a', 'pcm_s16le', '-ac', '1',
    wav,
  ]);

  return wav;
}

/**
 * Подменённый python резидентного режима: на проверку окружения печатает
 * заданный ответ, дальше читает запросы построчно, дописывает текст каждой
 * реплики в файл (по строке на реплику) и сам запрос — в журнал запросов, а
 * вместо речи отдаёт настоящий короткий WAV.
 */
async function fakeResidentPython(file, { probe, wav, stdin, requests, calls }) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `#!/usr/bin/env python3
import json, shutil, sys
args = sys.argv[1:]
open(${JSON.stringify(calls)}, 'a').write(' '.join(args) + '\\n')
if args[:1] == ['-c']:
    print(${JSON.stringify(probe)}); sys.exit(0)
for line in sys.stdin:
    if not line.strip():
        continue
    open(${JSON.stringify(requests)}, 'a').write(line)
    request = json.loads(line)
    results = []
    for item in request['items']:
        open(${JSON.stringify(stdin)}, 'a').write(item['text'] + '\\n')
        shutil.copyfile(${JSON.stringify(wav)}, item['out'])
        results.append({'durationMs': 1500, 'sampleRate': 48000, 'channels': 1, 'peak': 0.5})
    print(json.dumps({'id': request['id'], 'results': results}), flush=True)
`,
    'utf8',
  );
  await chmod(file, 0o755);
}

/** Подменённая установка Silero: python отвечает на проверку модуля и на синтез. */
async function fakeSilero(root, voiceDir) {
  const modelDir = path.join(voiceDir, 'silero', SILERO_VOICES[0].id);
  const stdin = path.join(root, 'stdin.txt');
  const requests = path.join(root, 'silero-requests.txt');

  await mkdir(modelDir, { recursive: true });
  await fakeResidentPython(path.join(voiceDir, 'silero-venv', 'bin', 'python'), {
    probe: '',
    wav: await sampleWave(root),
    stdin,
    requests,
    calls: path.join(root, 'silero-calls.txt'),
  });
  await writeFile(path.join(modelDir, SILERO_VOICES[0].fileName), 'модель', 'utf8');
  await writeFile(path.join(modelDir, 'voice.json'), JSON.stringify({
    schemaVersion: 1,
    id: SILERO_VOICES[0].id,
    name: SILERO_VOICES[0].name,
    language: 'ru',
    file: SILERO_VOICES[0].fileName,
    sampleRate: 48_000,
    speakers: SILERO_VOICES[0].speakers,
  }), 'utf8');

  return { stdin, requests };
}

/**
 * Подменённая установка Qwen3-TTS: проверка окружения отвечает «пакет есть,
 * видеокарта есть», а синтез — тот же резидентный протокол. Ставится отдельно
 * от Silero: голос по умолчанию — первый готовый движок, и с Qwen в установке
 * им становится он.
 */
async function fakeQwen(root, voiceDir) {
  const modelDir = path.join(voiceDir, 'qwen', QWEN_VOICES[0].id);
  const stdin = path.join(root, 'qwen-stdin.txt');
  const requests = path.join(root, 'qwen-requests.txt');
  const calls = path.join(root, 'qwen-calls.txt');

  await mkdir(modelDir, { recursive: true });
  await fakeResidentPython(path.join(voiceDir, 'qwen-venv', 'bin', 'python'), {
    probe: '1 1',
    wav: await sampleWave(root),
    stdin,
    requests,
    calls,
  });
  await writeFile(path.join(modelDir, 'voice.json'), JSON.stringify({
    schemaVersion: 1,
    id: QWEN_VOICES[0].id,
    name: QWEN_VOICES[0].name,
    language: 'ru',
    revision: QWEN_VOICES[0].revision,
    sampleRate: 24_000,
    speakers: QWEN_VOICES[0].speakers,
  }), 'utf8');

  return { stdin, requests, calls };
}

async function fixture(t, { qwen = false, transcribe = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-narration-'));
  let service = null;

  t.after(async () => {
    await service?.disable();
    await rm(root, { recursive: true, force: true });
  });

  const contractDir = path.join(root, 'profiles', 'demo-profile', 'showcase');

  await mkdir(contractDir, { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(contractDir, 'target.json'), JSON.stringify({
    version: 1,
    environment: 'read-only',
    project: { record: 'http://127.0.0.1:9', view: 'http://127.0.0.1:9' },
    sandbox: null,
    allowedOrigins: [],
    capabilities: ['record'],
  }), 'utf8');
  await writeFile(path.join(contractDir, 'screens.json'), JSON.stringify(SCREENS), 'utf8');

  const voiceDir = path.join(root, 'voice');
  const silero = await fakeSilero(root, voiceDir);
  const qwenFake = qwen ? await fakeQwen(root, voiceDir) : null;
  service = createShowcaseService({
    showcaseDir: path.join(root, 'showcase'),
    authDir: path.join(root, 'auth'),
    profilesDir: path.join(root, 'profiles'),
    stateDir: path.join(root, 'state'),
    browserPath: null,
    voiceDir,
    transcribe,
    listProjects: async () => ['demo-profile'],
    broadcast: () => {},
    limits: () => ({
      maxScenes: 20,
      maxSceneSeconds: 120,
      maxTotalSeconds: 600,
      retentionDays: 30,
      maxQueued: 4,
      jobTimeoutMs: 60_000,
    }),
  });

  await service.recover();

  const project = await service.createProject({
    ref: { kind: 'project', id: 'demo-profile' },
    profile: 'demo-profile',
    title: 'Ударения',
  });

  return { root, service, project, stdin: silero.stdin, qwen: qwenFake };
}

function timedTranscript(text = 'Точные метки.') {
  return {
    duration: 1.5,
    language: 'ru',
    model: 'small',
    segments: [{ text, start: 0.02, end: 1.5 }],
    words: [
      { text: 'Точные', start: 0.08, end: 0.48 },
      { text: 'метки', start: 0.7, end: 1.5 },
    ],
    wordTimestamps: true,
    wordTimingStatus: 'valid',
    wordTimingReason: 'Словесные метки распознавателя проверены.',
  };
}

async function addScene(service, project, title, narration) {
  return service.addScene(project.id, project.revision, {
    title,
    screenId: 'overview',
    narration,
    caption: title,
    subtitleText: '',
    startState: null,
    readyCondition: null,
    actions: [],
  });
}

async function waitForJob(service, jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = service.jobs.read(jobId);

    if (job.state !== 'queued' && job.state !== 'running') {
      return job;
    }

    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }

  throw new Error('озвучка не завершилась за отведённое время');
}

const TIMING_INPUTS = {
  targetFingerprint: 'timing-target',
  policyRevision: 'timing-policy',
  dataRevision: 'timing-data',
  style: {
    width: 1280,
    height: 720,
    fps: 30,
    theme: 'light',
    locale: 'ru',
    burnSubtitles: true,
  },
  versions: {
    recorder: 'timing-recorder-1',
    voice: 'timing-voice-input-1',
    assembler: 'timing-assembler-1',
  },
  stressDictionary: [],
};

function validNativeTiming() {
  return {
    source: 'edge',
    words: [
      { text: 'Точные', startMs: 80, endMs: 480 },
      { text: 'метки', startMs: 700, endMs: 1500.75 },
    ],
    segments: [
      { text: 'Точные метки.', startMs: 20, endMs: 1500.75 },
    ],
  };
}

/** Отдельный fake engine позволяет проверить транзакцию narration без сети. */
function timingNarrationOps(service, root, {
  timingOf,
  onSynthesize,
  transcribe = null,
  stressEntries = [],
  ignoredDirections = [],
}) {
  const calls = [];
  const inputs = [];
  const engine = {
    id: 'timing-fixture',
    name: 'Timing fixture',
    kind: 'local',
    capabilities: () => ({
      languages: ['ru'],
      tone: true,
      pace: true,
      emphasis: true,
      pause: true,
      stress: true,
      maxChars: 5000,
      supportedFormats: ['wav'],
      engineVersion: 'fixture-engine-1',
      modelRevision: 'fixture-model-1',
    }),
    doctor: async () => ({ status: 'ready', reason: '', install: '' }),
    voices: async () => [{
      id: 'voice',
      name: 'Fixture voice',
      language: 'ru',
      available: true,
      reason: '',
    }],
    async synthesize(input, options) {
      calls.push(input.canonicalText);
      inputs.push(structuredClone(input));
      await onSynthesize?.(input);

      const output = path.join(options.outputDir, `timing-${calls.length}.wav`);

      await mkdir(options.outputDir, { recursive: true });
      await copyFile(path.join(root, 'speech.wav'), output);

      const speechTiming = timingOf(input);

      return {
        temporaryFile: output,
        format: 'wav',
        sampleRate: 48_000,
        channels: 1,
        engineRequestId: `fixture-${calls.length}`,
        ignoredDirections,
        ...(speechTiming === undefined ? {} : { speechTiming }),
      };
    },
  };
  const voices = createVoiceRegistry([engine]);
  const ops = createNarrationOps({
    assertEnabled: () => {},
    broadcast: () => {},
    inputsOf: () => TIMING_INPUTS,
    jobs: service.jobs,
    readProject: service.store.readProject,
    store: service.store,
    transcribe,
    // Эти методы в тесте синтеза не вызываются; зависимость остаётся явной.
    voiceInstaller: /** @type {any} */ ({}),
    voices,
    previewDir: path.join(root, 'previews'),
    stressDictionary: { entries: () => stressEntries },
    withFreshness: (project) => project,
  });

  return { calls, inputs, ops };
}

test('preview своей реплики и полный TTS получают один подготовленный вход и раздельный кэш', async (t) => {
  const { root, service, project } = await fixture(t);
  const narration = 'Открываем замок и ёлку.';
  let current = await addScene(service, project, 'Своя реплика', narration);
  const sceneId = current.scenes[0].id;
  const from = parseNarration(narration).text.indexOf('замок');
  const rawOverrides = [{
    from,
    to: from + 'замок'.length,
    pronunciation: 'за\u0301мок',
    voiceRef: 'timing-fixture:voice',
  }];

  current = await service.updateScene(current.id, current.revision, sceneId, {
    pronunciationOverrides: rawOverrides,
  });

  const { calls, inputs, ops } = timingNarrationOps(service, root, {
    timingOf: () => undefined,
    onSynthesize: null,
    stressEntries: [{ word: 'ёлку', vowel: 0 }],
  });
  const previewInput = {
    voiceRef: 'timing-fixture:voice',
    narration,
    direction: current.scenes[0].direction,
    pronunciationOverrides: rawOverrides,
  };
  const firstPreview = await ops.previewNarration(previewInput);
  const secondPreview = await ops.previewNarration(previewInput);

  assert.equal(firstPreview, secondPreview);
  assert.equal(calls.length, 1, 'тот же preview повторно TTS не запускает');
  assert.equal(path.basename(firstPreview).startsWith('narration-'), true);
  assert.doesNotMatch(path.basename(firstPreview), /Открываем|замок|ёлку/u, 'текст не попадает в имя');

  const job = await ops.synthesizeScenes(current.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');
  assert.equal(calls.length, 2, 'полная озвучка — отдельный артефакт, не preview-файл');
  assert.deepEqual(inputs[0], inputs[1], 'preview и сборка используют один preparer');
  assert.equal(inputs[0].canonicalText, 'Открываем за\u0301мок и ёлку.');
  assert.deepEqual(inputs[0].direction.stresses, [{
    at: inputs[0].canonicalText.indexOf('ёлку'),
    vowel: 0,
  }]);

  const saved = (await service.store.readProject(current.id)).scenes[0];
  const voiced = {
    ...saved,
    audioSource: { ...saved.audioSource, voiceRef: 'timing-fixture:voice' },
  };

  assert.notEqual(
    audioInputHash(voiced, TIMING_INPUTS),
    audioInputHash({ ...voiced, pronunciationOverrides: [] }, TIMING_INPUTS),
    'реально применённая замена входит в свежесть WAV',
  );
});

test('preview ограничен пределом сцены даже у движка с длинными запросами', async (t) => {
  const { root, service } = await fixture(t);
  const { calls, ops } = timingNarrationOps(service, root, {
    timingOf: () => undefined,
    onSynthesize: null,
  });

  await assert.rejects(
    () => ops.previewNarration({
      voiceRef: 'timing-fixture:voice',
      narration: 'я'.repeat(401),
      direction: {
        tone: null,
        pace: null,
        emphasis: [],
        pauses: [],
        stresses: [],
      },
      pronunciationOverrides: [],
    }),
    (error) => (
      error.code === 'text_too_long'
      && error.status === 413
      && /401 из 400/.test(error.message)
    ),
  );
  assert.deepEqual(calls, [], 'слишком длинный текст до движка не доходит');
});

test('пропущенные слова и неподдержанные указания показываются одновременно', async (t) => {
  const { root, service, project } = await fixture(t);
  const current = await addScene(service, project, 'Проверка', 'Открываем фильтр.');
  const { ops } = timingNarrationOps(service, root, {
    timingOf: () => undefined,
    onSynthesize: null,
    transcribe: async () => 'Открываем.',
    ignoredDirections: ['ударение в слове «фильтр»'],
  });
  const job = await ops.synthesizeScenes(current.id);

  assert.equal((await waitForJob(service, job.id)).state, 'succeeded');

  const saved = (await service.store.readProject(current.id)).scenes[0];
  const speech = saved.checks.find((check) => check.kind === 'speech');

  assert.deepEqual(speech.suggestions, [
    'Не слышно: фильтр',
    'Движок не поддержал: ударение в слове «фильтр»',
  ]);
});

test('знак из сцены и запись словаря доезжают до движка, а субтитр остаётся чистым', async (t) => {
  const { service, project, stdin } = await fixture(t);

  await service.saveDictionary('# словарь установки\nзам+ок\n');

  const withScene = await addScene(service, project, 'Замки', 'Я купил з+амок, а потом замок.');
  const [scene] = withScene.scenes;

  assert.equal(scene.narration, 'Я купил з+амок, а потом замок.', 'текст хранится как набран');
  assert.equal(scene.subtitleText, 'Я купил замок, а потом замок.', 'в субтитре знака нет');

  const job = await service.synthesizeScenes(withScene.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');
  assert.equal(
    (await readFile(stdin, 'utf8')).trim(),
    'Я купил з+амок, а потом зам+ок.',
    'первый «замок» — знак человека, второй — из словаря',
  );

  // Проверка речи получила текст без знаков: пропущенных слов у неё нет, а
  // распознавания в тесте нет — статус «пропущено», не «пройдено».
  const voiced = await service.readProject(withScene.id);
  const speech = voiced.scenes[0].checks.find((check) => check.kind === 'speech');

  assert.equal(speech.status, 'skipped');
  assert.deepEqual(speech.suggestions, []);
});

test('латиница и цифры отвергаются до задания с названием сцены и обрывками', async (t) => {
  const { service, project } = await fixture(t);
  const withScene = await addScene(service, project, 'Отчёт', 'Открываем API за 2026 год.');

  await assert.rejects(
    () => service.synthesizeScenes(withScene.id),
    (error) => error.code === 'unreadable_text'
      && error.status === 409
      && /«Отчёт»/.test(error.message)
      && /латиница и цифры \(API, 2026\)/.test(error.message)
      && /словами/.test(error.message),
  );
  assert.equal(service.jobs.list(withScene.id).length, 0, 'задание не заведено');
});

test('правка словаря старит звук только сцен с этими словами', async (t) => {
  const { service, project, stdin } = await fixture(t);
  let current = await addScene(service, project, 'Динамика', 'Динамика позиций растёт.');

  current = await addScene(service, current, 'Фильтр', 'Фильтр включается одним нажатием.');

  const [dynamics, filter] = current.scenes;
  const first = await service.synthesizeScenes(current.id);

  assert.equal((await waitForJob(service, first.id)).state, 'succeeded');
  await assert.rejects(
    () => service.synthesizeScenes(current.id),
    (error) => error.code === 'nothing_to_synthesize',
    'без правок звук обеих сцен свежий',
  );

  await service.saveDictionary('дин+амика\n');

  // Устарела только сцена со словом из словаря: соседняя в задание не попадает.
  const second = await service.synthesizeScenes(current.id);

  assert.deepEqual(Object.keys(service.jobs.read(second.id).inputHashes), [dynamics.id]);
  assert.equal((await waitForJob(service, second.id)).state, 'succeeded');
  assert.match(await readFile(stdin, 'utf8'), /Дин\+амика позиций растёт\./);
  assert.doesNotMatch(await readFile(stdin, 'utf8'), /Фильтр включается[^\n]*\n[^]*Фильтр/, 'фильтр озвучен один раз');

  await assert.rejects(
    () => service.synthesizeScenes(current.id),
    (error) => error.code === 'nothing_to_synthesize',
  );

  // Возврат словаря к прежнему виду старит ту же сцену снова — и только её.
  await service.saveDictionary('');

  const third = await service.synthesizeScenes(current.id);

  assert.deepEqual(Object.keys(service.jobs.read(third.id).inputHashes), [dynamics.id]);
  assert.notEqual(dynamics.id, filter.id);
  // Уборка каталога ждёт конца задания: иначе она снесёт файлы из-под живой озвучки.
  assert.equal((await waitForJob(service, third.id)).state, 'succeeded');
});

test('сцены задания уходят в один процесс движка по одной, а проверяются после сеанса', async (t) => {
  const { service, project, qwen } = await fixture(t, { qwen: true });
  const titles = ['Первая', 'Вторая', 'Третья', 'Четвёртая', 'Пятая'];

  let current = project;

  for (const title of titles) {
    current = await addScene(service, current, title, `${title} сцена говорит своё.`);
  }

  const job = await service.synthesizeScenes(current.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');

  // Голос по умолчанию — Qwen, первый готовый движок; батча сцен у него нет, но
  // процесс с моделью один на всё задание: пять запросов, один подъём.
  const requests = (await readFile(qwen.requests, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(
    requests.map((request) => request.items.map((item) => item.text)),
    titles.map((title) => [`${title} сцена говорит своё.`]),
  );
  assert.equal(
    (await readFile(qwen.calls, 'utf8')).split('\n').filter((line) => line.includes('--serve')).length,
    1,
    'процесс с моделью поднят один раз на задание',
  );

  const voiced = await service.readProject(current.id);

  assert.ok(voiced.scenes.every((scene) => scene.audio && scene.audioSource.voiceRef === 'qwen:vivian'));
  assert.equal(
    voiced.scenes.filter((scene) => scene.checks.some((check) => check.kind === 'speech')).length,
    5,
    'проверка речи прошла по каждой сцене',
  );
});

test('батч режется по движку, числу реплик и сумме знаков, а первая реплика входит всегда', () => {
  const scene = (engineId, text) => ({ engineId, input: { canonicalText: text } });
  const pending = [
    scene('qwen', 'а'.repeat(500)),
    scene('qwen', 'б'.repeat(50)),
    scene('qwen', 'в'.repeat(60)),
    scene('silero', 'г'),
    scene('qwen', 'д'),
  ];
  const limit = { items: 4, chars: 600 };
  const texts = (batch) => batch.map((item) => item.input.canonicalText[0]);

  assert.deepEqual(texts(takeBatch(pending, 0, limit)), ['а', 'б'], 'третья не влезла по знакам');
  assert.deepEqual(texts(takeBatch(pending, 2, limit)), ['в'], 'на чужом движке батч кончается');
  assert.deepEqual(texts(takeBatch(pending, 3, limit)), ['г']);
  assert.deepEqual(texts(takeBatch(pending, 0, null)), ['а'], 'без предела — по одной');
  assert.deepEqual(takeBatch(pending, 5, limit), [], 'за концом списка батча нет');

  const giant = [scene('qwen', 'е'.repeat(900)), scene('qwen', 'ж')];

  assert.deepEqual(texts(takeBatch(giant, 0, limit)), ['е'], 'реплика длиннее предела идёт одна');
  assert.deepEqual(
    texts(takeBatch(Array.from({ length: 6 }, (_, index) => scene('qwen', String(index))), 0, limit)),
    ['0', '1', '2', '3'],
    'не больше предела по числу',
  );
});

test('нативные метки публикуются рядом с тем же WAV, а missing/invalid не ломают озвучку', async (t) => {
  const { root, service, project } = await fixture(t);
  let current = await addScene(service, project, 'Точные', 'Точные метки.');

  current = await addScene(service, current, 'Без меток', 'Метки отсутствуют.');
  current = await addScene(service, current, 'Неверные', 'Метки неверны.');

  const invalidTiming = {
    source: 'edge',
    words: [{ text: 'Метки', startMs: 100, endMs: 1600 }],
    segments: [{ text: 'Метки неверны.', startMs: 50, endMs: 1400 }],
  };
  const { calls, ops } = timingNarrationOps(service, root, {
    timingOf: (input) => {
      if (input.canonicalText === 'Точные метки.') {
        return validNativeTiming();
      }

      return input.canonicalText === 'Метки неверны.' ? invalidTiming : undefined;
    },
    onSynthesize: null,
  });
  const job = await ops.synthesizeScenes(current.id);
  const finished = await waitForJob(service, job.id);

  assert.equal(finished.state, 'succeeded', finished.error ?? '');
  assert.deepEqual(calls, ['Точные метки.', 'Метки отсутствуют.', 'Метки неверны.']);

  const saved = await service.store.readProject(current.id);
  const [valid, missing, invalid] = saved.scenes;

  assert.ok(valid.audio && valid.speechTiming);
  assert.ok(missing.audio);
  assert.equal(missing.speechTiming, null, 'отсутствующие metadata оставляют готовый WAV');
  assert.ok(invalid.audio);
  assert.equal(invalid.speechTiming, null, 'выход за длительность отвергает только metadata');

  const sourceWav = await readFile(path.join(root, 'speech.wav'));

  for (const scene of [valid, missing, invalid]) {
    const targetDir = path.join(
      service.store.namesOf(current.id).scenesDir,
      scene.id,
      'artifacts',
    );
    const publishedWav = await readFile(path.join(targetDir, `${scene.audio.id}.wav`));

    assert.ok(publishedWav.equals(sourceWav), `WAV сцены «${scene.title}» не изменён metadata`);
  }

  const targetDir = path.join(
    service.store.namesOf(current.id).scenesDir,
    valid.id,
    'artifacts',
  );
  const timingFile = path.join(targetDir, `${valid.speechTiming.id}.json`);
  const timingBytes = await readFile(timingFile);
  const timingDocument = JSON.parse(timingBytes.toString('utf8'));

  assert.equal(valid.audio.inputHash, audioInputHash(valid, TIMING_INPUTS));
  assert.equal(
    valid.speechTiming.inputHash,
    speechTimingInputHash(valid.audio.inputHash, valid.audio.contentHash),
  );
  assert.equal(
    valid.speechTiming.contentHash,
    createHash('sha256').update(timingBytes).digest('hex').slice(0, 32),
  );
  assert.equal(valid.speechTiming.byteSize, timingBytes.length);
  assert.equal(valid.speechTiming.producerVersion, SPEECH_TIMING_PRODUCER_VERSION);
  assert.deepEqual(timingDocument, {
    version: 1,
    audioContentHash: valid.audio.contentHash,
    source: 'edge',
    producerVersion: 'fixture-engine-1:fixture-model-1',
    extractionVersion: SPEECH_TIMING_PRODUCER_VERSION,
    durationMs: 1500,
    words: [
      { text: 'Точные', startMs: 80, endMs: 480 },
      { text: 'метки', startMs: 700, endMs: 1500 },
    ],
    segments: [{ text: 'Точные метки.', startMs: 20, endMs: 1500 }],
    quality: 'word-exact',
    status: 'valid',
    reason: 'Нативные метки поставщика проверены по длительности WAV.',
  });
  assert.deepEqual(await readSpeechTiming({
    ref: valid.speechTiming,
    sceneInputHash: valid.audio.inputHash,
    audioContentHash: valid.audio.contentHash,
    targetDir,
  }), timingDocument);
  assert.ok(
    !(await readdir(targetDir)).some((name) => name.includes('.tmp-')),
    'ссылка появляется только после атомарного rename JSON',
  );

  await writeFile(timingFile, Buffer.concat([timingBytes, Buffer.from(' ')]));

  assert.equal(await readSpeechTiming({
    ref: valid.speechTiming,
    sceneInputHash: valid.audio.inputHash,
    audioContentHash: valid.audio.contentHash,
    targetDir,
  }), null, 'изменённый JSON не проходит content hash');
  await assert.doesNotReject(() => service.store.readProject(current.id));
});

test('локальный голос переиспользует ровно один ASR и публикует его словесные метки', async (t) => {
  const { root, service, project } = await fixture(t);
  const current = await addScene(service, project, 'Локальная речь', 'Точные метки.');
  let asrCalls = 0;
  const { ops } = timingNarrationOps(service, root, {
    timingOf: () => undefined,
    onSynthesize: null,
    transcribe: async () => {
      asrCalls += 1;
      return timedTranscript();
    },
  });
  const job = await ops.synthesizeScenes(current.id);
  const finished = await waitForJob(service, job.id);
  const [saved] = (await service.store.readProject(current.id)).scenes;

  assert.equal(finished.state, 'succeeded', finished.error ?? '');
  assert.equal(asrCalls, 1, 'самопроверка и синхронизация делят один результат Whisper');
  assert.ok(saved.audio && saved.speechTiming);

  const targetDir = path.join(service.store.namesOf(current.id).scenesDir, saved.id, 'artifacts');
  const timing = await readSpeechTiming({
    ref: saved.speechTiming,
    sceneInputHash: saved.audio.inputHash,
    audioContentHash: saved.audio.contentHash,
    targetDir,
  });

  assert.equal(timing?.source, 'whisper');
  assert.equal(timing?.quality, 'word-exact');
  assert.deepEqual(timing?.words.map((word) => word.startMs), [80, 700]);
});

test('собственная запись сохраняет WAV, не вызывает TTS и проходит тот же одиночный ASR', async (t) => {
  let asrCalls = 0;
  const transcript = timedTranscript();
  const { root, service, project } = await fixture(t, {
    transcribe: async () => {
      asrCalls += 1;
      return transcript;
    },
  });
  const current = await addScene(service, project, 'Свой голос', 'Точные метки.');
  const importedDir = path.join(root, 'imported');

  await mkdir(importedDir, { recursive: true });

  const source = await sampleWave(importedDir);
  const sourceBytes = await readFile(source);
  const imported = await service.importSceneAudio(
    current.id,
    current.revision,
    current.scenes[0].id,
    source,
  );
  const [scene] = imported.scenes;

  assert.equal(asrCalls, 1);
  assert.equal(scene.audioSource.kind, 'recorded');
  assert.equal(scene.audioSource.voiceRef, null);
  assert.ok(scene.audio && scene.speechTiming);

  const targetDir = path.join(service.store.namesOf(current.id).scenesDir, scene.id, 'artifacts');
  const published = await readFile(path.join(targetDir, `${scene.audio.id}.wav`));
  const timing = await readSpeechTiming({
    ref: scene.speechTiming,
    sceneInputHash: scene.audio.inputHash,
    audioContentHash: scene.audio.contentHash,
    targetDir,
  });

  assert.ok(published.equals(sourceBytes), 'нормализованный PCM уже общего профиля и не подменён TTS');
  assert.equal(timing?.source, 'whisper');
  assert.equal(timing?.quality, 'word-exact');
});

test('syncStore не сортирует и не растягивает неверные provider spans', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-speech-timing-'));
  const targetDir = path.join(root, 'artifacts');

  t.after(() => rm(root, { recursive: true, force: true }));

  const base = {
    sceneInputHash: 'scene-input',
    audioContentHash: 'audio-content',
    producerVersion: 'fixture-engine-1',
    durationMs: 1500,
    targetDir,
  };
  const segment = [{ text: 'Фраза.', startMs: 0, endMs: 1400 }];
  const cases = [
    [{ text: 'NaN', startMs: Number.NaN, endMs: 100 }],
    [{ text: 'Минус', startMs: -1, endMs: 100 }],
    [{ text: 'Пустой', startMs: 100, endMs: 100 }],
    [
      { text: 'Позже', startMs: 300, endMs: 500 },
      { text: 'Раньше', startMs: 200, endMs: 250 },
    ],
    [{ text: 'Далеко', startMs: 100, endMs: 1500 + SPEECH_TIMING_END_TOLERANCE_MS + 0.01 }],
  ];

  for (const words of cases) {
    assert.equal(await publishSpeechTiming({
      ...base,
      timing: { source: 'edge', words, segments: segment },
    }), null);
  }

  assert.deepEqual(
    await readdir(targetDir).catch(() => []),
    [],
    'невалидные метки не оставляют даже производного файла',
  );
});

test('правка сцены во время TTS не прикрепляет ни старый WAV, ни его timing', async (t) => {
  const { root, service, project } = await fixture(t);
  const current = await addScene(service, project, 'Гонка', 'Точные метки.');
  const scene = current.scenes[0];
  let releaseSynthesis = () => {};
  let markStarted = () => {};
  const held = new Promise((resolve) => { releaseSynthesis = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const { calls, ops } = timingNarrationOps(service, root, {
    timingOf: () => validNativeTiming(),
    onSynthesize: async () => {
      markStarted();
      await held;
    },
  });
  const job = await ops.synthesizeScenes(current.id);

  try {
    await started;
    await service.updateScene(current.id, current.revision, scene.id, {
      narration: 'Текст изменился во время синтеза.',
    });
  } finally {
    releaseSynthesis();
  }

  const finished = await waitForJob(service, job.id);
  const saved = await service.store.readProject(current.id);
  const [raced] = saved.scenes;

  assert.equal(finished.state, 'succeeded', finished.error ?? '');
  assert.deepEqual(calls, ['Точные метки.'], 'гонка не запускает второй платный TTS');
  assert.equal(raced.narration, 'Текст изменился во время синтеза.');
  assert.equal(raced.audio, null, 'WAV прошлой редакции не становится актуальным');
  assert.equal(raced.speechTiming, null, 'timing прошлой редакции не получает ссылку');
});
