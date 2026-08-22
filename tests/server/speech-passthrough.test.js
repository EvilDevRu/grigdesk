import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  extractSceneFrames,
  ingestRecording,
  startIngestJob,
} from '../../server/src/lib/media/ingest.js';
import { runIngestWorker } from '../../server/src/lib/media/ingest-worker.js';
import {
  buildTranscribeArgv,
  decodeIngestJob,
  encodeIngestJob,
} from '../../server/src/lib/speech/transport.js';

const SENTINEL_SPEECH = Object.freeze({
  scenario: 'video',
  model: 'large-v3',
  language: 'en',
  device: 'cuda',
  computeType: 'float16',
  beamSize: 9,
  hotwords: 'Fastify, Pinia, Битрикс24',
  vadSilenceMs: 875,
  conditionOnPreviousText: false,
  initialPrompt: '',
});

/** Мок ffmpeg/ffprobe: сцены отдаёт по счётчику, seek-кадры и длительность — по запросу. */
function frameRunner({ scenes = 0, duration = 0, calls = [] } = {}) {
  return async function runProcess(cmd, args, options) {
    calls.push({ cmd, args, options });
    if (cmd === 'ffprobe') {
      return { out: JSON.stringify({ format: { duration }, streams: [] }), err: '' };
    }
    const target = String(args.at(-1));
    if (args.some((arg) => String(arg).includes('gt(scene,'))) {
      for (let i = 0; i < scenes; i += 1) {
        writeFileSync(target.replace('%03d', String(i + 1).padStart(3, '0')), 'scene');
      }
      return { out: '', err: '' };
    }
    writeFileSync(target, 'frame');
    return { out: '', err: '' };
  };
}

test('extractSceneFrames даёт локальному Inbox bounded набор кадров и передаёт abort signal', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-scene-frames-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.mp4');
  const destDir = path.join(root, 'frames');
  writeFileSync(filePath, 'video');
  const abort = new AbortController();
  const calls = [];

  const frames = await extractSceneFrames({
    filePath,
    destDir,
    maxFrames: 3,
    signal: abort.signal,
  }, { runProcess: frameRunner({ scenes: 3, calls }) });

  assert.deepEqual(frames, [1, 2, 3].map((n) => path.join(destDir, `frame-00${n}.jpg`)));
  // Сцен хватило — добор не запускается, ffprobe не зовётся.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'ffmpeg');
  assert.ok(calls[0].args.includes('3'));
  assert.equal(calls[0].options.signal, abort.signal);
  await assert.rejects(
    extractSceneFrames({ filePath, destDir, maxFrames: 13 }),
    /1\.\.12/u,
  );
});

test('extractSceneFrames берёт кадры по всей длительности у записи экрана без смен сцен', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-static-video-frame-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.mp4');
  const destDir = path.join(root, 'frames');
  writeFileSync(filePath, 'video');
  const calls = [];

  const frames = await extractSceneFrames({ filePath, destDir, maxFrames: 4 }, {
    runProcess: frameRunner({ scenes: 0, duration: 40, calls }),
  });

  // Скринкаст обязан дать ВСЕ maxFrames кадров, а не единственный первый.
  assert.deepEqual(frames, [1, 2, 3, 4].map((n) => path.join(destDir, `span-00${n}.jpg`)));
  assert.ok(calls[0].args.some((arg) => String(arg).includes('gt(scene,0.4)')));
  assert.equal(calls[1].cmd, 'ffprobe');
  // Середины интервалов: нулевая секунда — это ещё не начатое действие.
  assert.deepEqual(
    calls.slice(2).map((call) => call.args[call.args.indexOf('-ss') + 1]),
    ['5.000', '15.000', '25.000', '35.000'],
  );
});

test('extractSceneFrames дополняет недобор сцен равномерными кадрами', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-mixed-video-frame-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.mp4');
  const destDir = path.join(root, 'frames');
  writeFileSync(filePath, 'video');
  const calls = [];

  const frames = await extractSceneFrames({ filePath, destDir, maxFrames: 4 }, {
    runProcess: frameRunner({ scenes: 1, duration: 20, calls }),
  });

  // Одна найденная смена сцены больше не оставляет ролик с единственным кадром.
  assert.deepEqual(frames, [
    path.join(destDir, 'frame-001.jpg'),
    path.join(destDir, 'span-001.jpg'),
    path.join(destDir, 'span-002.jpg'),
    path.join(destDir, 'span-003.jpg'),
  ]);
});

test('extractSceneFrames откатывается к первому кадру, когда длительность неизвестна', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-unknown-duration-frame-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.mp4');
  const destDir = path.join(root, 'frames');
  writeFileSync(filePath, 'video');
  const calls = [];

  const frames = await extractSceneFrames({ filePath, destDir, maxFrames: 4 }, {
    async runProcess(cmd, args, options) {
      if (cmd === 'ffprobe') throw new Error('ffprobe недоступен');
      return frameRunner({ scenes: 0, calls })(cmd, args, options);
    },
  });

  assert.deepEqual(frames, [path.join(destDir, 'frame-001.jpg')]);
  assert.equal(calls.at(-1).args.includes('1'), true);
});

test('buildTranscribeArgv передаёт все настройки и не добавляет ложные флаги', () => {
  const argv = buildTranscribeArgv({
    scriptPath: '/runtime/transcribe.py',
    audioPath: '/work/audio.wav',
    options: SENTINEL_SPEECH,
    progressFile: '/work/progress.json',
  });
  assert.deepEqual(argv, [
    '/runtime/transcribe.py',
    '/work/audio.wav',
    '--model', 'large-v3',
    '--model-repo', 'Systran/faster-whisper-large-v3',
    '--model-revision', 'edaa852ec7e145841d8ffdb056a99866b5f0a478',
    '--lang', 'en',
    '--device', 'cuda',
    '--compute-type', 'float16',
    '--beam-size', '9',
    '--hotwords', 'Fastify, Pinia, Битрикс24',
    '--no-condition-previous',
    '--vad-silence-ms', '875',
    '--progress-file', '/work/progress.json',
  ]);
  assert.equal(argv.includes('--initial-prompt'), false);
  assert.equal(argv.includes('--hallucination-silence-threshold'), false);
});

test('непустая стилевая подсказка уезжает в argv одним аргументом', () => {
  const argv = buildTranscribeArgv({
    scriptPath: '/runtime/transcribe.py',
    audioPath: '/work/audio.wav',
    options: { ...SENTINEL_SPEECH, initialPrompt: 'Расшифровка встречи. С пунктуацией.' },
  });
  const at = argv.indexOf('--initial-prompt');
  assert.notEqual(at, -1, 'без флага видео снова распознаётся сплошным потоком');
  assert.equal(argv[at + 1], 'Расшифровка встречи. С пунктуацией.');
  assert.equal(
    argv.filter((item) => item === '--initial-prompt').length,
    1,
    'подсказка не должна дублироваться: whisper возьмёт последнюю и это будет молча',
  );
});

test('turbo argv передаёт canonical и разрешённые aliases на той же pinned revision', () => {
  const argv = buildTranscribeArgv({
    scriptPath: '/runtime/transcribe.py',
    audioPath: '/work/audio.wav',
    options: { ...SENTINEL_SPEECH, model: 'large-v3-turbo' },
  });
  assert.deepEqual(argv.slice(4, 12), [
    '--model-repo', 'dropbox-dash/faster-whisper-large-v3-turbo',
    '--model-revision', '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    '--model-alias', 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    '--lang', 'en',
  ]);
});

test('ingest job v2 переживает JSON round-trip, а decoder читает старый flat job', () => {
  const encoded = encodeIngestJob({
    jobId: 'job-v2',
    filePath: '/video.mp4',
    workDir: '/work',
    frames: 3,
    speech: SENTINEL_SPEECH,
    runtime: {
      pythonPath: '/venv/python',
      transcribePath: '/runtime/transcribe.py',
      mediaHfDir: '/state/hf',
    },
    startedAt: 100,
  });
  const decoded = decodeIngestJob(JSON.stringify(encoded));
  assert.equal(decoded.schemaVersion, 2);
  assert.deepEqual(decoded.speech, SENTINEL_SPEECH);
  assert.deepEqual(decoded.runtime, encoded.runtime);

  const legacy = decodeIngestJob({
    jobId: 'job-v1',
    filePath: '/legacy.mp4',
    workDir: '/legacy-work',
    model: 'large-v3',
    lang: 'en',
    beamSize: 7,
    hotwords: 'Cockpit',
    frames: 1,
  });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.speech.model, 'large-v3');
  assert.equal(legacy.speech.language, 'en');
  assert.equal(legacy.speech.beamSize, 7);
  assert.equal(legacy.speech.hotwords, 'Cockpit');
});

test('one-shot ingest довозит resolved options до Python argv и изолированного env', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-one-shot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.webm');
  const pythonPath = path.join(root, 'python');
  const workDir = path.join(root, 'work');
  const mediaHfDir = path.join(root, 'hf');
  writeFileSync(filePath, 'input');
  writeFileSync(pythonPath, 'fake');
  const calls = [];
  const fakeRun = async (cmd, args, options = {}) => {
    calls.push({ cmd, args, options });
    if (cmd === 'ffprobe') {
      return { out: JSON.stringify({ format: { duration: '12.5' }, streams: [{ codec_type: 'audio' }] }), err: '' };
    }
    if (cmd === pythonPath) {
      return {
        out: JSON.stringify({ language: 'en', duration: 12.5, segments: [{ start: 0, end: 1, text: 'ok' }] }),
        err: '',
      };
    }
    return { out: '', err: '' };
  };

  const result = await ingestRecording({
    filePath,
    workDir,
    frames: 0,
    speech: SENTINEL_SPEECH,
    pythonPath,
    transcribePath: '/runtime/transcribe.py',
    mediaHfDir,
    baseEnv: {
      PATH: '/bin',
      HF_HUB_CACHE: '/wrong',
      HUGGINGFACE_HUB_CACHE: '/legacy',
    },
  }, { runProcess: fakeRun });

  assert.equal(result.duration, 12.5);
  const pythonCall = calls.find((call) => call.cmd === pythonPath);
  assert.ok(pythonCall);
  assert.deepEqual(pythonCall.args, buildTranscribeArgv({
    scriptPath: '/runtime/transcribe.py',
    audioPath: path.join(workDir, 'audio.wav'),
    options: SENTINEL_SPEECH,
    progressFile: path.join(workDir, 'progress.json'),
  }));
  assert.equal(pythonCall.options.env.HF_HOME, mediaHfDir);
  assert.equal(pythonCall.options.env.HF_XET_CACHE, path.join(mediaHfDir, 'xet'));
  assert.equal('HF_HUB_CACHE' in pythonCall.options.env, false);
  assert.equal('HUGGINGFACE_HUB_CACHE' in pythonCall.options.env, false);
});

test('abort signal действует уже во время ffprobe и извлечения audio', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-abort-pipeline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.webm');
  const pythonPath = path.join(root, 'python');
  writeFileSync(filePath, 'input');
  writeFileSync(pythonPath, 'fake');

  for (const blockedStage of ['ffprobe', 'ffmpeg']) {
    const abort = new AbortController();
    let reached = false;
    const run = ingestRecording({
      filePath,
      workDir: path.join(root, blockedStage),
      pythonPath,
      mediaHfDir: path.join(root, 'hf'),
      signal: abort.signal,
    }, {
      runProcess: async (cmd, _args, options = {}) => {
        assert.equal(options.signal, abort.signal);
        if (cmd === 'ffprobe' && blockedStage !== 'ffprobe') {
          return {
            out: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] }),
            err: '',
          };
        }
        if (cmd !== blockedStage) return { out: '{}', err: '' };
        reached = true;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reached, true);
    abort.abort();
    await assert.rejects(run, (error) => error.name === 'AbortError');
  }
});

test('ingest помечает отсутствующий runtime и локальную модель стабильными error.code', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.webm');
  const pythonPath = path.join(root, 'python');
  writeFileSync(filePath, 'input');

  await assert.rejects(
    ingestRecording({ filePath, workDir: path.join(root, 'no-runtime'), pythonPath: '' }),
    (error) => error.code === 'speech_unavailable',
  );

  writeFileSync(pythonPath, 'fake');
  const fakeRun = async (cmd) => {
    if (cmd === 'ffprobe') {
      return { out: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'audio' }] }), err: '' };
    }
    if (cmd === pythonPath) {
      const error = new Error('LocalEntryNotFoundError: Cannot find an appropriate cached snapshot');
      error.stderr = error.message;
      throw error;
    }
    return { out: '', err: '' };
  };
  await assert.rejects(
    ingestRecording({
      filePath,
      workDir: path.join(root, 'missing-model'),
      pythonPath,
      mediaHfDir: path.join(root, 'hf'),
    }, { runProcess: fakeRun }),
    (error) => error.code === 'speech_model_missing',
  );
});

test('detached video job сохраняет speech целиком и передаёт worker тот же HF env', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-job-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'video.mp4');
  const jobsDir = path.join(root, 'jobs');
  const mediaHfDir = path.join(root, 'hf');
  writeFileSync(filePath, 'video');
  let spawned;
  let unrefCalled = false;
  const result = startIngestJob({
    filePath,
    workDir: path.join(root, 'work'),
    jobsDir,
    frames: 4,
    speech: SENTINEL_SPEECH,
    pythonPath: '/venv/python',
    transcribePath: '/runtime/transcribe.py',
    mediaHfDir,
    baseEnv: {
      PATH: '/bin',
      HF_HUB_CACHE: '/wrong',
      HUGGINGFACE_HUB_CACHE: '/legacy',
    },
  }, {
    createJobId: () => 'job-fixed',
    now: () => 123,
    spawn(cmd, args, options) {
      spawned = { cmd, args, options };
      return { unref: () => { unrefCalled = true; } };
    },
  });

  assert.equal(result.jobId, 'job-fixed');
  const stored = JSON.parse(readFileSync(result.statusPath, 'utf8'));
  assert.equal(statSync(result.statusPath).mode & 0o777, 0o600);
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.speech, SENTINEL_SPEECH);
  assert.equal(stored.startedAt, 123);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.env.HF_HOME, mediaHfDir);
  assert.equal(spawned.options.env.COCKPIT_MEDIA_HF_DIR, mediaHfDir);
  assert.equal('HF_HUB_CACHE' in spawned.options.env, false);
  assert.equal('HUGGINGFACE_HUB_CACHE' in spawned.options.env, false);
  assert.equal(unrefCalled, true);
});

test('тонкий worker декодирует nested speech и пишет финальный v2 status', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusPath = path.join(root, 'job.json');
  const job = encodeIngestJob({
    jobId: 'job-worker',
    filePath: '/video.mp4',
    workDir: root,
    frames: 2,
    speech: SENTINEL_SPEECH,
    runtime: {
      pythonPath: '/venv/python',
      transcribePath: '/runtime/transcribe.py',
      mediaHfDir: '/state/hf',
    },
    startedAt: 1,
  });
  let ingestCall;
  const final = await runIngestWorker(job, {
    statusPath,
    progressIntervalMs: 0,
    now: () => 999,
    async ingestRecording(value) {
      ingestCall = value;
      return { transcript: { segments: [{ text: 'готово' }] } };
    },
  });

  assert.deepEqual(ingestCall.speech, SENTINEL_SPEECH);
  assert.equal(ingestCall.pythonPath, '/venv/python');
  assert.equal(final.status, 'done');
  assert.equal(final.finishedAt, 999);
  const stored = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.equal(statSync(statusPath).mode & 0o777, 0o600);
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored.speech, SENTINEL_SPEECH);
  assert.equal(stored.status, 'done');
});

test('detached worker для auto один раз повторяет CUDA-class failure на CPU/int8', async () => {
  const autoSpeech = { ...SENTINEL_SPEECH, device: 'auto', computeType: 'auto' };
  const job = encodeIngestJob({
    jobId: 'job-auto-fallback',
    filePath: '/video.mp4',
    workDir: '/work',
    speech: autoSpeech,
  });
  const calls = [];
  const final = await runIngestWorker(job, {
    progressIntervalMs: 0,
    async ingestRecording(value) {
      calls.push(value.speech);
      if (calls.length === 1) throw new Error('CUDA out of memory');
      return { transcript: { segments: [] } };
    },
  });
  assert.deepEqual(calls.map(({ device, computeType }) => ({ device, computeType })), [
    { device: 'auto', computeType: 'auto' },
    { device: 'cpu', computeType: 'int8' },
  ]);
  assert.equal(final.status, 'done');
  assert.deepEqual(final.speech, autoSpeech, 'status хранит выбор человека, не execution fallback');
  assert.deepEqual(final.result.execution, {
    engine: 'whisper',
    mode: 'detached',
    device: 'cpu',
    fallback: 'cuda_failed',
  });
});

test('detached worker не скрывает CUDA failure при explicit device=cuda', async () => {
  const job = encodeIngestJob({
    jobId: 'job-explicit-cuda',
    filePath: '/video.mp4',
    workDir: '/work',
    speech: SENTINEL_SPEECH,
  });
  let calls = 0;
  const final = await runIngestWorker(job, {
    progressIntervalMs: 0,
    async ingestRecording() {
      calls += 1;
      throw new Error('CUDA out of memory');
    },
  });
  assert.equal(calls, 1);
  assert.equal(final.status, 'failed');
  assert.match(final.error, /CUDA out of memory/);
});

test('transcribe.py вызывает WhisperModel только fail-closed', () => {
  const scriptPath = fileURLToPath(new URL('../../server/src/lib/media/transcribe.py', import.meta.url));
  const source = String.raw`
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('cockpit_transcribe', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
def snapshot_download(**kwargs):
    calls.append({'kind': 'snapshot', 'kwargs': kwargs})
    return '/pinned/snapshot'
sys.modules['huggingface_hub'] = types.SimpleNamespace(snapshot_download=snapshot_download)
class BrokenWhisperModel:
    def __new__(cls, *args, **kwargs):
        calls.append({'kind': 'model', 'args': args, 'kwargs': kwargs})
        raise RuntimeError('нет локальной модели')
args = types.SimpleNamespace(
    model='medium',
    model_repo='Systran/faster-whisper-medium',
    model_revision='08e178d48790749d25932bbc082711ddcfdfbc4f',
    model_alias=[],
    device='cpu',
    compute_type='int8',
)
try:
    module.load_model(BrokenWhisperModel, args)
except RuntimeError:
    pass
print(json.dumps(calls))
`;
  const run = spawnSync('python3', ['-c', source, scriptPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const calls = JSON.parse(run.stdout);
  assert.equal(calls.length, 2, 'ошибка локальной загрузки не включает сетевой retry');
  assert.deepEqual(calls[0].kwargs, {
    repo_id: 'Systran/faster-whisper-medium',
    revision: '08e178d48790749d25932bbc082711ddcfdfbc4f',
    local_files_only: true,
  });
  assert.deepEqual(calls[1].args, ['/pinned/snapshot']);
  assert.equal(calls[1].kwargs.local_files_only, true);
});

test('transcribe.py находит alias-only snapshot без сети и без смены revision', () => {
  const scriptPath = fileURLToPath(new URL('../../server/src/lib/media/transcribe.py', import.meta.url));
  const source = String.raw`
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('cockpit_transcribe', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
revision = '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'
def snapshot_download(**kwargs):
    calls.append({'kind': 'snapshot', 'kwargs': kwargs})
    if kwargs['repo_id'].startswith('dropbox-dash/'):
        raise RuntimeError('canonical snapshot отсутствует локально')
    return '/hf/alias-pinned-snapshot'
sys.modules['huggingface_hub'] = types.SimpleNamespace(snapshot_download=snapshot_download)
class WhisperModel:
    def __init__(self, *args, **kwargs):
        calls.append({'kind': 'model', 'args': args, 'kwargs': kwargs})
args = types.SimpleNamespace(
    model='large-v3-turbo',
    model_repo='dropbox-dash/faster-whisper-large-v3-turbo',
    model_revision=revision,
    model_alias=['mobiuslabsgmbh/faster-whisper-large-v3-turbo'],
    device='cpu',
    compute_type='int8',
)
module.load_model(WhisperModel, args)
print(json.dumps(calls))
`;
  const run = spawnSync('python3', ['-c', source, scriptPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const calls = JSON.parse(run.stdout);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.kwargs), [
    {
      repo_id: 'dropbox-dash/faster-whisper-large-v3-turbo',
      revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
      local_files_only: true,
    },
    {
      repo_id: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
      revision: '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
      local_files_only: true,
    },
  ]);
  assert.deepEqual(calls[2].args, ['/hf/alias-pinned-snapshot']);
  assert.equal(calls[2].kwargs.local_files_only, true);
});

test('warmup и CUDA probe тоже разрешают alias-only snapshot на pinned SHA', () => {
  const warmupPath = fileURLToPath(new URL('../../server/src/lib/speech/warmup-worker.py', import.meta.url));
  const cudaPath = fileURLToPath(new URL('../../server/src/lib/speech/cuda-probe.py', import.meta.url));
  const source = String.raw`
import importlib.util, json, sys, types
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
calls = []
def snapshot_download(**kwargs):
    calls.append(kwargs)
    if kwargs['repo_id'].startswith('dropbox-dash/'):
        raise RuntimeError('canonical отсутствует')
    return '/hf/alias-snapshot'
args = types.SimpleNamespace(
    model_repo='dropbox-dash/faster-whisper-large-v3-turbo',
    model_revision='0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    model_alias=['mobiuslabsgmbh/faster-whisper-large-v3-turbo'],
)
results = [
    load('warmup_worker', sys.argv[1]).resolve_snapshot(snapshot_download, args),
    load('cuda_probe', sys.argv[2]).resolve_snapshot(snapshot_download, args),
]
print(json.dumps({'calls': calls, 'results': results}))
`;
  const run = spawnSync('python3', ['-c', source, warmupPath, cudaPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(payload.results, ['/hf/alias-snapshot', '/hf/alias-snapshot']);
  assert.equal(payload.calls.length, 4);
  assert.deepEqual(new Set(payload.calls.map((call) => call.revision)), new Set([
    '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
  ]));
  assert.equal(payload.calls.every((call) => call.local_files_only === true), true);
});

test('transcribe.py пробрасывает beam/hotwords/condition/VAD в faster-whisper', () => {
  const scriptPath = fileURLToPath(new URL('../../server/src/lib/media/transcribe.py', import.meta.url));
  const source = String.raw`
import contextlib, importlib.util, io, json, sys, types
spec = importlib.util.spec_from_file_location('cockpit_transcribe', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
def snapshot_download(**kwargs):
    calls.append({'kind': 'snapshot', 'kwargs': kwargs})
    return '/pinned/snapshot'
class WhisperModel:
    def __init__(self, *args, **kwargs):
        calls.append({'kind': 'init', 'args': args, 'kwargs': kwargs})
        self.max_length = 448
        self.hf_tokenizer = types.SimpleNamespace(
            encode=lambda text, add_special_tokens=False: types.SimpleNamespace(ids=list(range(224)))
        )
    def transcribe(self, *args, **kwargs):
        calls.append({'kind': 'transcribe', 'kwargs': kwargs})
        info = types.SimpleNamespace(duration=1.0, language='en', language_probability=0.9)
        return iter([]), info
sys.modules['faster_whisper'] = types.SimpleNamespace(WhisperModel=WhisperModel)
sys.modules['huggingface_hub'] = types.SimpleNamespace(snapshot_download=snapshot_download)
sys.argv = ['transcribe.py', '/audio.wav', '--model', 'large-v3', '--lang', 'en',
            '--model-repo', 'Systran/faster-whisper-large-v3',
            '--model-revision', 'edaa852ec7e145841d8ffdb056a99866b5f0a478',
            '--device', 'cuda', '--compute-type', 'float16', '--beam-size', '9',
            '--hotwords', 'Fastify', '--no-condition-previous', '--vad-silence-ms', '875'] + sys.argv[2:]
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    module.main()
print(json.dumps({'calls': calls, 'result': json.loads(stdout.getvalue())}))
`;
  const run = spawnSync('python3', ['-c', source, scriptPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(payload.calls[0].kwargs, {
    repo_id: 'Systran/faster-whisper-large-v3',
    revision: 'edaa852ec7e145841d8ffdb056a99866b5f0a478',
    local_files_only: true,
  });
  assert.deepEqual(payload.calls[1].args, ['/pinned/snapshot']);
  assert.equal(payload.calls[1].kwargs.local_files_only, true);
  assert.deepEqual(payload.calls[2].kwargs, {
    language: 'en',
    beam_size: 9,
    hotwords: 'Fastify',
    condition_on_previous_text: false,
    initial_prompt: null,
    word_timestamps: false,
    vad_filter: true,
    vad_parameters: { min_silence_duration_ms: 875 },
  });
  assert.equal(payload.result.hotwordsTokens, 224);
  assert.equal(payload.result.hotwordsTruncated, true);

  // Тот же скрипт с подсказкой обязан САМ поднять выравнивание по словам. Замер на
  // large-v3-turbo: без него модель повторяет текст подсказки вместо речи, поэтому
  // передать промпт и не включить word_timestamps — это тихая порча расшифровки.
  const withPrompt = spawnSync(
    'python3',
    ['-c', source, scriptPath, '--initial-prompt', 'Расшифровка встречи. С пунктуацией.'],
    { encoding: 'utf8' },
  );
  assert.equal(withPrompt.status, 0, withPrompt.stderr);
  const prompted = JSON.parse(withPrompt.stdout).calls[2].kwargs;
  assert.equal(prompted.initial_prompt, 'Расшифровка встречи. С пунктуацией.');
  assert.equal(prompted.word_timestamps, true);
});

test('one-shot и warmup считают словарь точным tokenizer и тем же лимитом среза', () => {
  const transcribePath = fileURLToPath(new URL('../../server/src/lib/media/transcribe.py', import.meta.url));
  const warmupPath = fileURLToPath(new URL('../../server/src/lib/speech/warmup-worker.py', import.meta.url));
  const source = String.raw`
import importlib.util, json, sys, types
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
class Tokenizer:
    def __init__(self, count): self.count = count
    def encode(self, text, add_special_tokens):
        assert text == ' термин'
        assert add_special_tokens is False
        return types.SimpleNamespace(ids=list(range(self.count)))
def model(count):
    return types.SimpleNamespace(hf_tokenizer=Tokenizer(count), max_length=448)
payload = {}
for name, module_path in [('oneShot', sys.argv[1]), ('warmup', sys.argv[2])]:
    module = load(name, module_path)
    payload[name] = {
        'fits': module.measure_hotwords(model(223), 'термин'),
        'cut': module.measure_hotwords(model(224), 'термин'),
        'empty': module.measure_hotwords(model(999), ''),
    }
print(json.dumps(payload))
`;
  const run = spawnSync('python3', ['-c', source, transcribePath, warmupPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  for (const mode of ['oneShot', 'warmup']) {
    assert.deepEqual(payload[mode], {
      fits: { hotwordsTokens: 223, hotwordsTruncated: false },
      cut: { hotwordsTokens: 224, hotwordsTruncated: true },
      empty: { hotwordsTokens: 0, hotwordsTruncated: false },
    });
  }
});
