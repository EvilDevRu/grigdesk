import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MediaAdapter } from '../../server/src/adapters/media.js';
import {
  DEFAULT_VIDEO_INITIAL_PROMPT,
  SPEECH_MODEL_CATALOG,
  SpeechRuntime,
  pythonEnv,
  resolveSpeechOptions,
} from '../../server/src/lib/speech/index.js';

test('каталог моделей закрепляет allowlist полными commit SHA', () => {
  assert.deepEqual(Object.keys(SPEECH_MODEL_CATALOG), [
    'small',
    'medium',
    'large-v3',
    'large-v3-turbo',
  ]);
  for (const model of Object.values(SPEECH_MODEL_CATALOG)) {
    assert.match(model.revision, /^[0-9a-f]{40}$/);
  }
  assert.equal(
    SPEECH_MODEL_CATALOG['large-v3-turbo'].repo,
    'dropbox-dash/faster-whisper-large-v3-turbo',
  );
});

test('resolveSpeechOptions разделяет dictation и video overrides', () => {
  const settings = {
    quality: 'fast',
    videoQuality: 'accurate',
    model: 'large-v3',
    videoModel: 'small',
    language: 'en',
    dictionary: ' Fastify\nБитрикс24 ',
    device: 'cuda',
    beamSize: 9,
    vadSilenceMs: 875,
    conditionOnPreviousText: false,
  };

  assert.deepEqual(resolveSpeechOptions(settings, 'dictation'), {
    scenario: 'dictation',
    model: 'large-v3',
    language: 'en',
    device: 'cuda',
    computeType: 'float16',
    beamSize: 9,
    hotwords: 'Fastify\nБитрикс24',
    vadSilenceMs: 875,
    conditionOnPreviousText: false,
    initialPrompt: '',
  });
  assert.deepEqual(resolveSpeechOptions(settings, 'video'), {
    scenario: 'video',
    model: 'small',
    language: 'en',
    device: 'cuda',
    computeType: 'float16',
    beamSize: 5,
    hotwords: 'Fastify\nБитрикс24',
    vadSilenceMs: 500,
    conditionOnPreviousText: true,
    initialPrompt: DEFAULT_VIDEO_INITIAL_PROMPT,
  });
});

test('стилевая подсказка принадлежит видео, а очистка поля уважается', () => {
  assert.ok(
    resolveSpeechOptions({}, 'video').initialPrompt.length > 0,
    'без подсказки видео распознаётся сплошным потоком без пунктуации',
  );
  // Подсказка — заголовок, который модель продолжает речью. Развёрнутое указание она
  // продолжает таким же указанием и повторяет его вместо разговора (замер: четыре
  // одинаковых сегмента на 79 секунд). Потолок стережёт дефолт от такого разрастания.
  assert.ok(
    [...DEFAULT_VIDEO_INITIAL_PROMPT].length <= 80,
    'дефолтная подсказка должна оставаться коротким заголовком, а не инструкцией модели',
  );
  assert.equal(
    resolveSpeechOptions({}, 'dictation').initialPrompt,
    '',
    'диктовка короткая и правится руками: подсказка ей не назначается',
  );
  assert.equal(
    resolveSpeechOptions({ videoInitialPrompt: '' }, 'video').initialPrompt,
    '',
    'пустое поле — осознанный выбор человека, дефолт не возвращается молча',
  );
  assert.equal(
    resolveSpeechOptions({ videoInitialPrompt: ' Стенограмма\nвстречи. ' }, 'video').initialPrompt,
    'Стенограмма встречи.',
    'подсказка уезжает в argv одной строкой',
  );
  assert.throws(
    () => resolveSpeechOptions({ videoInitialPrompt: 'я'.repeat(601) }, 'video'),
    /videoInitialPrompt/,
  );
});

test('transcribe.py не разрывает пару initial_prompt + word_timestamps', () => {
  const source = readFileSync(
    new URL('../../server/src/lib/media/transcribe.py', import.meta.url),
    'utf8',
  );
  // Замер на large-v3-turbo: голый initial_prompt при condition_on_previous_text уводит
  // модель в петлю — она повторяет текст подсказки вместо речи. Выравнивание по словам
  // снимает петлю, поэтому включаться оно обязано ровно вместе с промптом.
  assert.match(
    source,
    /word_timestamps=bool\(initial_prompt\)/,
    'word_timestamps должен следовать из наличия промпта, а не задаваться отдельно',
  );
  assert.match(source, /initial_prompt=initial_prompt/);
});

test('resolveSpeechOptions даёт совместимые дефолты и отвергает неизвестное', () => {
  assert.deepEqual(resolveSpeechOptions({}, 'dictation'), {
    scenario: 'dictation',
    model: 'medium',
    language: 'ru',
    device: 'cpu',
    computeType: 'int8',
    beamSize: 5,
    hotwords: '',
    vadSilenceMs: 500,
    conditionOnPreviousText: true,
    initialPrompt: '',
  });
  assert.throws(() => resolveSpeechOptions({ quality: 'maximum' }, 'dictation'), /quality/);
  assert.throws(() => resolveSpeechOptions({ videoModel: 'repo\/arbitrary' }, 'video'), /модель/i);
  assert.throws(() => resolveSpeechOptions({}, 'meeting'), /сценарий/i);

  assert.equal(
    resolveSpeechOptions({ device: 'auto' }, 'dictation').computeType,
    'auto',
    'auto разрешается в execution, а не преждевременно превращается в CPU int8',
  );
});

test('pythonEnv очищает HF override и добавляет cublas из выбранного venv', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sitePackages = path.join(root, 'venv', 'lib', 'python3.10', 'site-packages');
  mkdirSync(sitePackages, { recursive: true });
  const env = pythonEnv({
    mediaHfDir: '/state/hf',
    pythonPath: path.join(root, 'venv', 'bin', 'python'),
    baseEnv: {
      PATH: '/bin',
      LD_LIBRARY_PATH: '/system/cuda',
      HF_HOME: '/old/home',
      HF_HUB_CACHE: '/old/hub',
      HUGGINGFACE_HUB_CACHE: '/legacy/hub',
      HF_XET_CACHE: '/old/xet',
    },
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HF_HOME, '/state/hf');
  assert.equal(env.HF_XET_CACHE, path.join('/state/hf', 'xet'));
  assert.equal('HF_HUB_CACHE' in env, false);
  assert.equal('HUGGINGFACE_HUB_CACHE' in env, false);
  assert.equal(
    env.LD_LIBRARY_PATH,
    `${path.join(sitePackages, 'nvidia', 'cublas', 'lib')}${path.delimiter}/system/cuda`,
  );
});

test('SpeechRuntime кэширует capabilities и маршрутизирует оба сценария', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'audio.webm');
  writeFileSync(filePath, 'audio');
  const ingestCalls = [];
  const videoCalls = [];
  let probes = 0;
  let preflightOptions;
  const baseEnv = { PATH: '/runtime/bin' };
  const runtime = new SpeechRuntime({
    mediaDir: path.join(root, 'media'),
    mediaHfDir: path.join(root, 'hf'),
    pythonPath: '/runtime/python',
    transcribePath: '/runtime/transcribe.py',
    baseEnv,
    deps: {
      preflight(options) {
        probes += 1;
        preflightOptions = options;
        const ready = probes > 1;
        return {
          ok: ready,
          checks: [{ name: ready ? 'готово' : 'python отсутствует', ok: ready, fix: 'установить' }],
          venvPython: options.pythonPath,
        };
      },
      inspectSpeechModelCache() {
        return Object.keys(SPEECH_MODEL_CATALOG).map((modelId) => ({
          modelId,
          repo: SPEECH_MODEL_CATALOG[modelId].repo,
          revision: SPEECH_MODEL_CATALOG[modelId].revision,
          cached: true,
          sizeMb: 1,
        }));
      },
      runCudaCanary: () => ({ state: 'no_device', reason: 'тест без GPU' }),
      async ingestRecording(value) {
        ingestCalls.push(value);
        assert.equal(existsSync(value.workDir), true);
        return { transcript: { segments: [] } };
      },
      startIngestJob(value) {
        videoCalls.push(value);
        return { jobId: `job-${videoCalls.length}`, statusPath: '/status.json' };
      },
      readIngestJob(jobId, jobsDir) {
        return { jobId, jobsDir };
      },
    },
  });

  assert.equal((await runtime.capabilities()).local.ready, false);
  assert.equal((await runtime.capabilities()).local.reason, 'python отсутствует');
  assert.equal(probes, 1);
  assert.equal(preflightOptions.pythonPath, '/runtime/python');
  assert.equal(preflightOptions.env.PATH, '/runtime/bin');
  assert.equal(preflightOptions.env.HF_HOME, path.join(root, 'hf'));
  await assert.rejects(
    runtime.transcribe({ filePath }),
    (error) => error.code === 'speech_unavailable',
  );
  await runtime.refreshCapabilities();
  assert.equal(probes, 2);

  const result = await runtime.transcribe({
    filePath,
    settings: { quality: 'fast', model: 'small', dictionary: 'Codex' },
  });
  assert.deepEqual(result, {
    transcript: { segments: [] },
    execution: { engine: 'whisper', mode: 'one-shot', device: 'cpu' },
  });
  assert.equal(ingestCalls[0].speech.scenario, 'dictation');
  assert.equal(ingestCalls[0].speech.hotwords, 'Codex');
  const ownedWorkDir = ingestCalls[0].workDir;
  assert.equal(existsSync(ownedWorkDir), false, 'runtime чистит только созданный им temp-dir');

  runtime.startVideoJob({
    filePath,
    settings: { videoQuality: 'accurate', videoModel: 'large-v3', model: 'small' },
  });
  runtime.startVideoJob({ filePath, settings: { videoQuality: 'balanced' } });
  assert.equal(videoCalls[0].speech.scenario, 'video');
  assert.equal(videoCalls[0].speech.model, 'large-v3');
  assert.notEqual(videoCalls[0].workDir, videoCalls[1].workDir);
  assert.deepEqual(runtime.readVideoJob('job-x'), {
    jobId: 'job-x',
    jobsDir: path.join(root, 'media', 'jobs'),
  });
});

test('MediaAdapter сохраняет legacy model/lang, но передаёт их как video settings', () => {
  let call;
  const fakeRuntime = {
    mediaDir: '/media',
    jobsDir: '/media/jobs',
    capabilities: () => ({ ok: true }),
    startVideoJob(value) {
      call = value;
      return { jobId: 'job-1' };
    },
    readVideoJob: (jobId) => ({ jobId }),
    transcribe: (value) => value,
  };
  const adapter = new MediaAdapter({ speechRuntime: fakeRuntime });
  assert.deepEqual(adapter.ingest({
    filePath: '/video.mp4',
    model: 'large-v3',
    lang: 'en',
    settings: { videoQuality: 'accurate' },
  }), { jobId: 'job-1' });
  assert.equal(call.settings.videoModel, 'large-v3');
  assert.equal(call.settings.language, 'en');
  assert.deepEqual(adapter.status('job-1'), { jobId: 'job-1' });
});
