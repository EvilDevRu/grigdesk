import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SPEECH_MODEL_CATALOG,
  SpeechRuntime,
  buildSpeechStreamArgv,
  buildWarmupArgv,
  createWarmupProcess,
  readProcessIdentity,
  sameProcessIdentity,
  speechOptionsRevision,
} from '../../server/src/lib/speech/index.ts';

function models() {
  return Object.values(SPEECH_MODEL_CATALOG).map((model) => ({
    modelId: model.modelId,
    repo: model.repo,
    revision: model.revision,
    cached: true,
    sizeMb: 1,
  }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeChild(pid = 701) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

function runtimeHarness({
  now = () => 1_000,
  maxWarmups = 4,
  createController = null,
} = {}) {
  let uuid = 0;
  const created = [];
  const ingests = [];
  const runtime = new SpeechRuntime({
    mediaDir: '/state/media',
    warmupTtlMs: 100,
    maxWarmups,
    deps: {
      now,
      randomUUID: () => `uuid-${++uuid}`,
      preflight: async () => ({ ok: true, checks: [], venvPython: '/venv/python' }),
      probeSpeechModelCache: async () => models(),
      runCudaCanary: async () => ({ state: 'no_device', reason: 'нет GPU' }),
      async createWarmupProcess(args) {
        const record = {
          args,
          calls: [],
          cancels: 0,
          behavior: null,
        };
        const index = created.length;
        const controller = createController?.(record, index) || {
          identity: {
            pid: 500 + index,
            starttime: String(10_000 + index),
            cmdline: ['/venv/python', '/worker.py', args.nonce],
            nonce: args.nonce,
          },
          async transcribe(value) {
            record.calls.push(value);
            if (record.behavior) return record.behavior(value);
            return {
              model: args.options.model,
              duration: 1,
              hotwordsTokens: args.options.hotwords ? 2 : 0,
              hotwordsTruncated: false,
              segments: [{ text: args.options.hotwords || args.options.model }],
            };
          },
          async cancel() {
            record.cancels += 1;
            return true;
          },
        };
        record.controller = controller;
        created.push(record);
        return controller;
      },
      async ingestRecording(value) {
        ingests.push(value);
        return {
          transcript: {
            model: value.speech.model,
            hotwordsTokens: 0,
            hotwordsTruncated: false,
            segments: [{ text: 'one-shot' }],
          },
        };
      },
      statSync: () => ({ size: 42 }),
    },
  });
  return { runtime, created, ingests };
}

test('warmup argv закрепляет repo, SHA, aliases и весь resolved contract', () => {
  const options = {
    scenario: 'dictation',
    model: 'large-v3-turbo',
    language: 'en',
    device: 'cuda',
    computeType: 'float16',
    beamSize: 7,
    hotwords: 'GrigDesk',
    vadSilenceMs: 800,
    conditionOnPreviousText: false,
  };
  const argv = buildWarmupArgv({ workerPath: '/worker.py', nonce: 'nonce-1', options });
  assert.deepEqual(argv, [
    '/worker.py',
    '--nonce', 'nonce-1',
    '--model', 'large-v3-turbo',
    '--model-repo', 'dropbox-dash/faster-whisper-large-v3-turbo',
    '--model-revision', '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    '--model-alias', 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    '--lang', 'en',
    '--device', 'cuda',
    '--compute-type', 'float16',
    '--beam-size', '7',
    '--vad-silence-ms', '800',
    '--hotwords', 'GrigDesk',
    '--no-condition-previous',
  ]);
  assert.equal(speechOptionsRevision(options), speechOptionsRevision({ ...options }));
  assert.equal(speechOptionsRevision(options, 'prefs-rev-7'), 'prefs-rev-7');
});

test('word timestamps идут в warmup request и не ломают общий stream argv', async () => {
  const child = fakeChild(704);
  const writes = [];
  let argv;

  child.stdin.on('data', (chunk) => writes.push(chunk.toString('utf8')));

  const controller = createWarmupProcess({
    pythonPath: '/venv/python',
    options: { model: 'medium', device: 'cpu', wordTimestamps: true },
    nonce: 'nonce-words',
  }, {
    spawn(_command, args) {
      argv = args;
      return child;
    },
    readProcessIdentity() {
      return {
        pid: child.pid,
        starttime: '444',
        cmdline: ['/venv/python', ...argv],
        nonce: 'nonce-words',
      };
    },
  });

  child.stdout.write(`${JSON.stringify({ type: 'ready', nonce: 'nonce-words' })}\n`);
  await controller.ready;

  const pending = controller.transcribe({
    filePath: '/audio.wav',
    wordTimestamps: true,
  });

  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(writes.join('').trim());

  assert.equal(request.wordTimestamps, true);
  assert.equal(argv.includes('--word-timestamps'), false);
  assert.equal(buildSpeechStreamArgv({
    workerPath: '/stream-worker.py',
    nonce: 'stream-nonce',
    options: { model: 'medium', device: 'cpu', wordTimestamps: true },
  }).includes('--word-timestamps'), false);

  child.stdout.write(`${JSON.stringify({
    type: 'result',
    requestId: request.requestId,
    result: {
      duration: 1,
      segments: [{ start: 0, end: 1, text: 'Да да' }],
      words: [
        { start: 0.1, end: 0.4, text: 'да' },
        { start: 0.6, end: 0.9, text: 'да' },
      ],
      word_timestamps: true,
    },
  })}\n`);

  const result = await pending;

  assert.equal(result.wordTimingStatus, 'valid');
  assert.deepEqual(result.words.map((word) => word.text), ['да', 'да']);
  child.emit('close', 0);
});

test('warmup-worker возвращает ту же плоскую структуру слов только по запросу', () => {
  const workerPath = fileURLToPath(new URL(
    '../../server/src/lib/speech/warmup-worker.py',
    import.meta.url,
  ));
  const source = String.raw`
import contextlib, importlib.util, io, json, sys, types
worker_path = sys.argv[1]
requested = sys.argv[2] == 'true'
spec = importlib.util.spec_from_file_location('grigdesk_warmup_worker', worker_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = []
def snapshot_download(**kwargs):
    return '/pinned/snapshot'
class WhisperModel:
    def __init__(self, *args, **kwargs):
        pass
    def transcribe(self, *args, **kwargs):
        calls.append(kwargs)
        words = [
            types.SimpleNamespace(word=' да', start=0.1, end=0.4),
            types.SimpleNamespace(word=' да', start=0.6, end=0.9),
        ]
        segment = types.SimpleNamespace(text=' Да да ', start=0.0, end=1.0, words=words)
        info = types.SimpleNamespace(duration=1.0, language='ru', language_probability=0.9)
        return iter([segment]), info
sys.modules['faster_whisper'] = types.SimpleNamespace(WhisperModel=WhisperModel)
sys.modules['huggingface_hub'] = types.SimpleNamespace(snapshot_download=snapshot_download)
sys.argv = ['warmup-worker.py', '--nonce', 'nonce', '--model', 'medium',
            '--model-repo', 'repo', '--model-revision', 'revision']
request = {'type': 'transcribe', 'requestId': 'request-1', 'filePath': '/audio.wav',
           'wordTimestamps': requested}
sys.stdin = io.StringIO(json.dumps(request) + '\n')
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    module.main()
print(json.dumps({'lines': stdout.getvalue().splitlines(), 'calls': calls}))
`;
  const runWorker = (requested) => {
    const run = spawnSync(
      'python3',
      ['-c', source, workerPath, String(requested)],
      { encoding: 'utf8' },
    );

    assert.equal(run.status, 0, run.stderr);

    const payload = JSON.parse(run.stdout);
    const result = JSON.parse(payload.lines[1]).result;

    return { payload, result };
  };
  const withoutWords = runWorker(false);
  const withWords = runWorker(true);

  assert.equal(withoutWords.payload.calls[0].word_timestamps, false);
  assert.equal(withoutWords.result.word_timestamps, false);
  assert.deepEqual(withoutWords.result.words, []);
  assert.equal(withWords.payload.calls[0].word_timestamps, true);
  assert.equal(withWords.result.word_timestamps, true);
  assert.deepEqual(withWords.result.words.map((word) => word.text), ['да', 'да']);
});

test('/proc identity включает pid, starttime, полный argv и nonce', () => {
  const statFields = Array(20).fill('0');
  statFields[0] = 'S';
  statFields[19] = '98765';
  const identity = readProcessIdentity(42, {
    nonce: 'nonce-42',
    read(file) {
      if (file.endsWith('/stat')) return `42 (python worker) ${statFields.join(' ')}`;
      return Buffer.from('python\0/worker.py\0--nonce\0nonce-42\0');
    },
  });
  assert.deepEqual(identity, {
    pid: 42,
    starttime: '98765',
    cmdline: ['python', '/worker.py', '--nonce', 'nonce-42'],
    nonce: 'nonce-42',
  });
  assert.equal(sameProcessIdentity(identity, identity), true);
  assert.equal(sameProcessIdentity(identity, { ...identity, starttime: '98766' }), false);
  assert.equal(sameProcessIdentity(identity, {
    ...identity,
    cmdline: ['python', '/other.py', '--nonce', 'nonce-42'],
  }), false);
  assert.equal(sameProcessIdentity(identity, { ...identity, cmdline: ['python', '/worker.py'] }), false);
});

test('stale/reused PID не получает TERM или KILL', async () => {
  const child = fakeChild();
  let argv;
  let identityReads = 0;
  const immediateTimer = (callback) => {
    queueMicrotask(callback);
    return { unref() {} };
  };
  const controller = createWarmupProcess({
    pythonPath: '/venv/python',
    options: { model: 'medium', device: 'cpu' },
    nonce: 'nonce-stale',
  }, {
    spawn(_command, args) {
      argv = args;
      return child;
    },
    readProcessIdentity() {
      identityReads += 1;
      if (identityReads === 1) {
        return { pid: child.pid, starttime: '111', cmdline: ['/venv/python', ...argv], nonce: 'nonce-stale' };
      }
      return { pid: child.pid, starttime: '222', cmdline: ['/bin/sleep', '99'], nonce: 'nonce-stale' };
    },
    setTimeout: immediateTimer,
    clearTimeout: () => {},
  });

  await controller.cancel();
  assert.deepEqual(child.signals, []);
  assert.ok(identityReads >= 3);
});

test('spawn без pid fail-closed и поздний ENOENT не становится unhandled error', () => {
  const child = fakeChild();
  child.pid = undefined;
  assert.throws(() => createWarmupProcess({
    pythonPath: '/missing/python',
    options: { model: 'medium', device: 'cpu' },
    nonce: 'nonce-missing',
  }, {
    spawn: () => child,
  }), /PID/);
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
});

test('initial identity read failure не сигналит по raw PID', () => {
  const child = fakeChild(703);
  assert.throws(() => createWarmupProcess({
    pythonPath: '/venv/python',
    options: { model: 'medium', device: 'cpu' },
    nonce: 'nonce-identity-failure',
  }, {
    spawn: () => child,
    readProcessIdentity: () => null,
  }), /process identity/);
  assert.deepEqual(child.signals, [], 'без exact identity child.kill не вызывается');
  assert.equal(child.stdin.writableEnded, true, 'warmup получает cooperative EOF');
});

test('abort во время ожидания ready немедленно отменяет warmup и не пишет request', async () => {
  const child = fakeChild(702);
  let argv;
  const writes = [];
  child.stdin.on('data', (chunk) => writes.push(chunk));
  child.stdin.once('finish', () => setImmediate(() => child.emit('close', 0)));
  const controller = createWarmupProcess({
    pythonPath: '/venv/python',
    options: { model: 'medium', device: 'cpu' },
    nonce: 'nonce-abort',
    killGraceMs: 10,
  }, {
    spawn(_command, args) {
      argv = args;
      return child;
    },
    readProcessIdentity() {
      return {
        pid: child.pid,
        starttime: '333',
        cmdline: ['/venv/python', ...argv],
        nonce: 'nonce-abort',
      };
    },
  });
  const abort = new AbortController();
  const transcribe = controller.transcribe({ filePath: '/audio.webm', signal: abort.signal });
  abort.abort();
  await assert.rejects(transcribe, (error) => error.name === 'AbortError');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(writes.length, 0, 'путь к файлу не уходит после abort до ready');
});

test('два окна получают независимые warmup и предъявляют их в обратном порядке', async (t) => {
  const { runtime, created, ingests } = runtimeHarness();
  t.after(() => runtime.shutdown());
  const first = await runtime.warmup({
    settings: {
      quality: 'balanced',
      model: 'medium',
      dictionary: 'Первый',
      wordTimestamps: true,
    },
    optionsRevision: 'rev-first',
  });
  const second = await runtime.warmup({
    settings: { quality: 'fast', model: 'small', dictionary: 'Второй' },
    optionsRevision: 'rev-second',
  });
  assert.notEqual(first.warmupId, second.warmupId);
  assert.equal(first.optionsRevision, 'rev-first');
  assert.equal(second.optionsRevision, 'rev-second');

  const secondResult = await runtime.transcribe({
    filePath: '/second.webm',
    workDir: '/work/second',
    warmupId: second.warmupId,
    settings: { model: 'large-v3', dictionary: 'Изменено после старта' },
  });
  const firstResult = await runtime.transcribe({
    filePath: '/first.webm',
    workDir: '/work/first',
    warmupId: first.warmupId,
    settings: { model: 'large-v3', dictionary: 'Тоже изменено' },
  });

  assert.equal(secondResult.transcript.model, 'small');
  assert.equal(firstResult.transcript.model, 'medium');
  assert.equal(secondResult.execution.optionsRevision, 'rev-second');
  assert.equal(firstResult.execution.optionsRevision, 'rev-first');
  assert.equal(created[1].calls[0].filePath, '/second.webm');
  assert.equal(created[1].calls[0].wordTimestamps, false);
  assert.equal(created[0].calls[0].filePath, '/first.webm');
  assert.equal(created[0].calls[0].wordTimestamps, true);
  assert.equal(created[0].args.options.hotwords, 'Первый');
  assert.equal(created[1].args.options.hotwords, 'Второй');
  assert.equal(ingests.length, 0);
});

test('claim атомарен: только один concurrent upload использует warm process', async (t) => {
  const { runtime, created, ingests } = runtimeHarness();
  t.after(() => runtime.shutdown());
  const warmup = await runtime.warmup({ settings: { model: 'medium' } });
  const held = deferred();
  created[0].behavior = () => held.promise;

  const claimed = runtime.transcribe({
    filePath: '/claimed.webm',
    workDir: '/work/claimed',
    warmupId: warmup.warmupId,
  });
  const duplicate = runtime.transcribe({
    filePath: '/duplicate.webm',
    workDir: '/work/duplicate',
    warmupId: warmup.warmupId,
  });
  const duplicateResult = await duplicate;
  assert.equal(duplicateResult.execution.mode, 'one-shot');
  assert.equal(ingests.length, 1);

  held.resolve({ model: 'medium', duration: 1, segments: [] });
  const claimedResult = await claimed;
  assert.equal(claimedResult.execution.mode, 'warmup');
  assert.equal(created[0].calls.length, 1);

  const repeated = await runtime.transcribe({
    filePath: '/repeated.webm',
    workDir: '/work/repeated',
    warmupId: warmup.warmupId,
  });
  assert.equal(repeated.execution.mode, 'one-shot');
  assert.equal(ingests.length, 2);
});

test('cancel и expiry удаляют только свой warmup, затем upload безопасно идёт one-shot', async (t) => {
  let clock = 1_000;
  const { runtime, created, ingests } = runtimeHarness({ now: () => clock });
  t.after(() => runtime.shutdown());
  const cancelled = await runtime.warmup({ settings: { model: 'medium' } });
  assert.equal(await runtime.cancelWarmup(cancelled.warmupId), true);
  assert.equal(await runtime.cancelWarmup(cancelled.warmupId), false);
  assert.equal(created[0].cancels, 1);
  assert.equal((await runtime.transcribe({
    filePath: '/cancelled.webm',
    workDir: '/work/cancelled',
    warmupId: cancelled.warmupId,
  })).execution.mode, 'one-shot');

  const expired = await runtime.warmup({ settings: { model: 'medium' } });
  clock = expired.expiresAt;
  assert.equal((await runtime.transcribe({
    filePath: '/expired.webm',
    workDir: '/work/expired',
    warmupId: expired.warmupId,
  })).execution.mode, 'one-shot');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created[1].cancels, 1);
  assert.equal(ingests.length, 2);
});

test('пятый warmup получает stable busy и не создаёт пятый процесс', async () => {
  const { runtime, created } = runtimeHarness({ maxWarmups: 4 });
  for (let index = 0; index < 4; index += 1) {
    await runtime.warmup({ settings: { model: 'medium' } });
  }
  await assert.rejects(
    runtime.warmup({ settings: { model: 'medium' } }),
    (error) => error.code === 'speech_warmup_busy',
  );
  assert.equal(created.length, 4);
  await runtime.shutdown();
  assert.deepEqual(created.map((record) => record.cancels), [1, 1, 1, 1]);
  await assert.rejects(
    runtime.warmup({ settings: { model: 'medium' } }),
    (error) => error.code === 'speech_unavailable',
  );
});

test('runtime отвергает controller без полной process identity и гасит его', async () => {
  const { runtime, created } = runtimeHarness({
    createController(record) {
      return {
        identity: { pid: 900, starttime: '1', cmdline: ['/worker.py'], nonce: 'не тот' },
        async cancel() {
          record.cancels += 1;
        },
      };
    },
  });
  await assert.rejects(runtime.warmup({ settings: { model: 'medium' } }), /process identity/);
  assert.equal(created.length, 1);
  assert.equal(created[0].cancels, 1);
  await runtime.shutdown();
});
