import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  SPEECH_STREAM_AUDIO,
  SPEECH_STREAM_PROTOCOL_VERSION,
  STREAM_WORKER_PY,
  buildSpeechStreamArgv,
  createSpeechStreamProcess,
} from '../../server/src/lib/speech/streamProcess.ts';
import {
  SpeechStreamSession,
  advanceLocalAgreement,
} from '../../server/src/lib/speech/stream.ts';
import { SpeechRuntime } from '../../server/src/lib/speech/index.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeChild(pid = 801) {
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

function manualTimers() {
  const timers = [];
  return {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false, called: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    runThrough(maxDelay = Infinity) {
      for (const timer of [...timers].sort((left, right) => left.delay - right.delay)) {
        if (timer.cleared || timer.called || timer.delay > maxDelay) continue;
        timer.called = true;
        timer.callback();
      }
    },
  };
}

function fakeController() {
  const calls = [];
  let cancels = 0;
  const controller = {
    ready: Promise.resolve({ type: 'ready' }),
    exit: new Promise(() => {}),
    decode(call) {
      const pending = deferred();
      const abort = () => pending.reject(Object.assign(new Error('abort'), { name: 'AbortError' }));
      call.signal?.addEventListener('abort', abort, { once: true });
      pending.promise.finally(() => call.signal?.removeEventListener('abort', abort)).catch(() => {});
      calls.push({ call, pending });
      return pending.promise;
    },
    async cancel() {
      cancels += 1;
      return true;
    },
  };
  return { controller, calls, cancelCount: () => cancels };
}

function tempSession(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-speech-stream-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const harness = fakeController();
  const filePath = path.join(root, 'audio.pcm');
  const session = new SpeechStreamSession({
    controller: harness.controller,
    filePath,
    decodeIntervalMs: 10,
    overlapMs: 5,
    maxWindowMs: 1_000,
    maxPendingMs: 100,
    maxDurationMs: 1_000,
    maxFrameBytes: 2_048,
    drainTimeoutMs: 100,
    ...options,
  });
  return { root, filePath, session, ...harness };
}

function words(...items) {
  return items.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));
}

function workerResult(call, outputWords) {
  return {
    window: {
      startByte: call.startByte,
      endByte: call.endByte,
      offsetMs: call.offsetMs,
      final: call.final,
    },
    words: outputWords,
  };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('stream argv закрепляет тот же pinned local model contract', () => {
  assert.deepEqual(buildSpeechStreamArgv({
    workerPath: '/stream-worker.py',
    nonce: 'stream-nonce',
    options: {
      model: 'large-v3-turbo',
      language: 'ru',
      device: 'cpu',
      computeType: 'int8',
      beamSize: 3,
      hotwords: 'GrigDesk',
      vadSilenceMs: 700,
      conditionOnPreviousText: false,
    },
  }), [
    '/stream-worker.py',
    '--nonce', 'stream-nonce',
    '--model', 'large-v3-turbo',
    '--model-repo', 'dropbox-dash/faster-whisper-large-v3-turbo',
    '--model-revision', '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
    '--model-alias', 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    '--lang', 'ru',
    '--device', 'cpu',
    '--compute-type', 'int8',
    '--beam-size', '3',
    '--vad-silence-ms', '700',
    '--hotwords', 'GrigDesk',
    '--no-condition-previous',
  ]);
});

test('stream process принимает несколько decode строго по одному', async () => {
  const child = fakeChild();
  let argv;
  let requestNumber = 0;
  const writes = [];
  child.stdin.on('data', (chunk) => writes.push(chunk.toString('utf8')));
  child.stdin.once('finish', () => setImmediate(() => child.emit('close', 0, null)));
  const controller = createSpeechStreamProcess({
    pythonPath: '/venv/python',
    options: { model: 'medium', device: 'cpu' },
    nonce: 'stream-process',
    readyTimeoutMs: 1_000,
    decodeTimeoutMs: 1_000,
    killGraceMs: 5,
  }, {
    spawn(_command, args) {
      argv = args;
      return child;
    },
    randomUUID: () => `request-${++requestNumber}`,
    readProcessIdentity() {
      return {
        pid: child.pid,
        starttime: '444',
        cmdline: ['/venv/python', ...argv],
        nonce: 'stream-process',
      };
    },
  });

  child.stdout.write(`${JSON.stringify({
    type: 'ready',
    nonce: 'stream-process',
    protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
    audio: {
      encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, frameSamples: 1_600,
    },
  })}\n`);
  await controller.ready;

  const first = controller.decode({
    filePath: '/private/audio.pcm',
    startByte: 0,
    endByte: 320,
    offsetMs: 0,
  });
  await assert.rejects(
    controller.decode({ filePath: '/private/audio.pcm', startByte: 0, endByte: 640, offsetMs: 0 }),
    (error) => error.code === 'speech_stream_busy',
  );
  await tick();
  const firstRequest = JSON.parse(writes.join('').trim());
  assert.deepEqual(firstRequest, {
    type: 'decode',
    requestId: 'request-1',
    filePath: '/private/audio.pcm',
    startByte: 0,
    endByte: 320,
    offsetMs: 0,
    final: false,
  });
  child.stdout.write(`${JSON.stringify({
    type: 'result',
    requestId: 'request-1',
    result: { window: {}, words: [] },
  })}\n`);
  assert.deepEqual(await first, { window: {}, words: [] });

  writes.length = 0;
  const second = controller.decode({
    filePath: '/private/audio.pcm',
    startByte: 320,
    endByte: 960,
    offsetMs: 10,
    final: true,
  });
  await tick();
  assert.equal(JSON.parse(writes.join('').trim()).requestId, 'request-2');
  child.stdout.write(`${JSON.stringify({
    type: 'result',
    requestId: 'request-2',
    result: { window: {}, words: [{ text: ' тест' }] },
  })}\n`);
  assert.equal((await second).words[0].text, ' тест');
  assert.equal(await controller.cancel(), true);
  assert.equal((await controller.exit).expected, true);
});

test('stream process не сигналит reused PID при отмене', async () => {
  const child = fakeChild(802);
  let argv;
  let reads = 0;
  const controller = createSpeechStreamProcess({
    pythonPath: '/venv/python',
    options: { model: 'small', device: 'cpu' },
    nonce: 'stream-stale',
    readyTimeoutMs: 10_000,
    killGraceMs: 5,
  }, {
    spawn(_command, args) { argv = args; return child; },
    readProcessIdentity() {
      reads += 1;
      if (reads === 1) {
        return { pid: child.pid, starttime: '100', cmdline: ['/venv/python', ...argv], nonce: 'stream-stale' };
      }
      return { pid: child.pid, starttime: '101', cmdline: ['/bin/sleep', '99'], nonce: 'stream-stale' };
    },
    setTimeout(callback, delay) {
      if (delay < 100) queueMicrotask(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  await assert.rejects(
    controller.cancel(),
    (error) => error.code === 'speech_unavailable',
  );
  assert.deepEqual(child.signals, []);
  assert.ok(reads >= 3);
  assert.equal(controller.isAlive(), true, 'без child close процесс остаётся в quarantine');
});

test('initial identity failure возвращает controller и держит exit barrier до close', async () => {
  const child = fakeChild(803);
  const timers = manualTimers();
  const controller = createSpeechStreamProcess({
    pythonPath: '/venv/python',
    options: { model: 'small', device: 'cpu' },
    nonce: 'stream-no-identity',
    readyTimeoutMs: 10_000,
    killGraceMs: 5,
  }, {
    spawn() { return child; },
    readProcessIdentity() { return null; },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  assert.equal(controller.identity, null);
  await assert.rejects(controller.ready, (error) => error.code === 'speech_unavailable');
  await tick();
  timers.runThrough(100);
  await assert.rejects(controller.cancel(), (error) => error.code === 'speech_unavailable');
  assert.deepEqual(child.signals, [], 'без exact identity нельзя посылать даже TERM');
  assert.equal(controller.isAlive(), true);

  child.emit('close', 1, null);
  assert.equal((await controller.exit).expected, true);
  assert.equal(controller.isAlive(), false);
});

test('асинхронный child error без close остаётся quarantined без unhandled rejection', async () => {
  const child = fakeChild(804);
  const timers = manualTimers();
  let argv;
  const controller = createSpeechStreamProcess({
    pythonPath: '/venv/python',
    options: { model: 'small', device: 'cpu' },
    nonce: 'stream-child-error',
    readyTimeoutMs: 10_000,
    killGraceMs: 5,
  }, {
    spawn(_command, args) { argv = args; return child; },
    readProcessIdentity() {
      return {
        pid: child.pid,
        starttime: '8040',
        cmdline: ['/venv/python', ...argv],
        nonce: 'stream-child-error',
      };
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  child.emit('error', new Error('spawn transport failed'));
  await assert.rejects(controller.ready, /spawn transport failed/);
  timers.runThrough(100);
  await assert.rejects(controller.cancel(), (error) => error.code === 'speech_unavailable');
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(controller.isAlive(), true);
  child.emit('close', 1, null);
  await controller.exit;
});

test('LocalAgreement закрепляет только общий префикс двух гипотез', () => {
  const first = advanceLocalAgreement(null, words(
    [' Привет', 100, 300],
    [' мир', 320, 500],
  ));
  assert.equal(first.committedText, '');
  assert.equal(first.partialText, 'Привет мир');

  const second = advanceLocalAgreement(first, words(
    [' Привет', 110, 310],
    [' мир', 330, 510],
    [' сегодня', 530, 800],
  ));
  assert.equal(second.committedText, 'Привет мир');
  assert.equal(second.partialText, 'сегодня');

  const final = advanceLocalAgreement(second, words(
    [' Привет', 100, 300],
    [' мир', 320, 500],
    [' сегодня', 540, 810],
    ['.', 820, 840],
  ), { final: true });
  assert.equal(final.committedText, 'Привет мир сегодня.');
  assert.equal(final.partialText, '');
  assert.equal(final.text, 'Привет мир сегодня.');
});

test('session делает один decode, схлопывает watermark и Stop возвращает final один раз', async (t) => {
  const { session, calls, filePath, ...harness } = tempSession(t);
  const events = [];
  session.on('event', (event) => events.push(event));
  await session.start();

  const frame = Buffer.alloc(320);
  session.pushFrame(1, frame);
  session.pushFrame(2, frame);
  session.pushFrame(3, frame);
  assert.equal(calls.length, 1, 'пока первый decode занят, очередной не стартует');
  assert.equal(calls[0].call.endByte, 320);

  calls[0].pending.resolve(workerResult(calls[0].call, words(
    [' Привет', 1, 3],
    [' мир', 4, 6],
  )));
  await tick();
  assert.equal(calls.length, 2, 'накопившиеся кадры схлопнулись до последнего watermark');
  assert.equal(calls[1].call.endByte, 960);
  calls[1].pending.resolve(workerResult(calls[1].call, words(
    [' Привет', 1, 3],
    [' мир', 4, 6],
    [' сегодня', 7, 9],
  )));
  await tick();

  const stopping = session.stop();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].call.final, true);
  assert.equal(calls[2].call.endByte, 960);
  calls[2].pending.resolve(workerResult(calls[2].call, words(
    [' Привет', 1, 3],
    [' мир', 4, 6],
    [' сегодня', 7, 9],
    ['.', 9, 10],
  )));
  const result = await stopping;
  assert.equal(result.text, 'Привет мир сегодня.');
  assert.equal(result.processedUntilMs, 30);
  assert.equal(result.receivedUntilMs, 30);
  assert.equal(result.lagMs, 0);
  assert.equal(result.ackSeq, 3);
  assert.deepEqual(await session.stop(), result, 'повторный Stop возвращает сохранённый result');
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(events.filter((event) => event.type === 'final').length, 1);
  assert.equal(events.filter((event) => event.type === 'partial').length, 2);
  assert.equal(harness.cancelCount(), 1);
  assert.equal(existsSync(filePath), false, 'приватный raw удалён после done');
});

test('пустые VAD-окна продвигают безопасный watermark и не теряют позднюю речь', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-speech-stream-silence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let cancels = 0;
  const session = new SpeechStreamSession({
    controller: {
      ready: Promise.resolve({ type: 'ready' }),
      exit: new Promise(() => {}),
      async decode(call) {
        calls.push(call);
        const output = call.endByte >= 32_000 * 32
          ? words([' поздняя', 30_200, 30_650], [' речь', 30_700, 31_100])
          : [];
        return workerResult(call, output);
      },
      async cancel() {
        cancels += 1;
        return true;
      },
    },
    filePath: path.join(root, 'audio.pcm'),
    decodeIntervalMs: 2_000,
    overlapMs: 1_500,
    maxWindowMs: 30_000,
    maxPendingMs: 30_000,
    maxDurationMs: 60_000,
    maxFrameBytes: 64_000,
  });
  const events = [];
  session.on('event', (event) => events.push(event));
  await session.start();

  // 17 кадров по 2 секунды: без advancement rolling window упал бы после 30 секунд тишины.
  for (let seq = 1; seq <= 17; seq += 1) {
    session.pushFrame(seq, Buffer.alloc(64_000));
    await tick();
  }

  assert.equal(session.snapshot().state, 'recording');
  assert.ok(session.snapshot().prunedUntilMs > 0);
  assert.ok(calls.every((call) => call.endByte - call.startByte <= 32_000 * 30));
  assert.ok(calls.at(-1).startByte > 0, 'старую подтверждённую тишину больше не декодируем');
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(events.at(-1).text, 'поздняя речь');
  assert.equal(events.at(-1).committed, 'поздняя речь');
  assert.equal(await session.cancel(), true);
  assert.equal(cancels, 1);
});

test('session deadlines fail-closed гасят idle и hard-limit диктовки', async (t) => {
  async function expectDeadline(innerT, options, feed = null) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-speech-stream-deadline-'));
    innerT.after(() => rmSync(root, { recursive: true, force: true }));
    let cancels = 0;
    const session = new SpeechStreamSession({
      controller: {
        ready: Promise.resolve({ type: 'ready' }),
        exit: new Promise(() => {}),
        decode: async (call) => workerResult(call, []),
        async cancel() { cancels += 1; return true; },
      },
      filePath: path.join(root, 'audio.pcm'),
      decodeIntervalMs: 10,
      maxWindowMs: 1_000,
      maxPendingMs: 1_000,
      maxDurationMs: 1_000,
      idleTimeoutMs: options.idleTimeoutMs,
      hardTimeoutMs: options.hardTimeoutMs,
    }, {
      // Production timers unref-нуты. В тесте оставляем native timer referenced,
      // иначе isolated node:test вправе завершить event loop до deadline.
      setTimeout(callback, milliseconds) {
        const native = setTimeout(callback, milliseconds);
        return { native, unref() {} };
      },
      clearTimeout(handle) { clearTimeout(handle?.native); },
    });
    const terminal = new Promise((resolve) => {
      session.on('event', (event) => {
        if (event.type === 'error') resolve(event);
      });
    });
    await session.start();
    feed?.(session);
    const event = await terminal;
    assert.equal(event.code, 'speech_stream_timeout');
    assert.equal(session.snapshot().state, 'failed');
    assert.equal(cancels, 1);
  }

  await t.test('idle deadline', (innerT) => expectDeadline(innerT, {
    idleTimeoutMs: 20,
    hardTimeoutMs: 1_000,
  }));
  await t.test('hard deadline', (innerT) => expectDeadline(innerT, {
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 20,
  }, (session) => session.pushFrame(1, Buffer.alloc(2))));
});

test('session fail-closed проверяет seq, PCM, duration и decode backpressure', async (t) => {
  await t.test('seq gap', async (t) => {
    const { session } = tempSession(t);
    const events = [];
    session.on('event', (event) => events.push(event));
    await session.start();
    assert.throws(() => session.pushFrame(2, Buffer.alloc(2)), (error) => error.code === 'speech_stream_protocol');
    await tick();
    assert.equal(events.at(-1).type, 'error');
  });

  await t.test('odd PCM', async (t) => {
    const { session } = tempSession(t);
    await session.start();
    assert.throws(() => session.pushFrame(1, Buffer.alloc(3)), (error) => error.code === 'speech_stream_protocol');
  });

  await t.test('total duration', async (t) => {
    const { session } = tempSession(t, { maxDurationMs: 10, maxPendingMs: 10 });
    await session.start();
    assert.throws(() => session.pushFrame(1, Buffer.alloc(322)), (error) => error.code === 'speech_stream_too_long');
  });

  await t.test('decode lag', async (t) => {
    const { session, calls } = tempSession(t, { maxPendingMs: 10 });
    await session.start();
    session.pushFrame(1, Buffer.alloc(320));
    assert.equal(calls.length, 1);
    assert.throws(() => session.pushFrame(2, Buffer.alloc(2)), (error) => error.code === 'speech_stream_backpressure');
  });
});

test('Stop timeout гасит worker, а поздний decode не создаёт final/done', async (t) => {
  const { session, calls, ...harness } = tempSession(t);
  const events = [];
  session.on('event', (event) => events.push(event));
  await session.start();
  session.pushFrame(1, Buffer.alloc(320));
  const stopping = session.stop({ drainTimeoutMs: 10 });
  await assert.rejects(stopping, (error) => error.code === 'speech_stream_timeout');
  await tick();
  assert.equal(harness.cancelCount(), 1);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assert.equal(events.some((event) => event.type === 'final' || event.type === 'done'), false);
  assert.equal(calls[0].call.signal.aborted, true);
});

test('cancel во время finishing не воскресает в final/done после death barrier', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-speech-stream-finish-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const barrier = deferred();
  let cancels = 0;
  const session = new SpeechStreamSession({
    controller: {
      ready: Promise.resolve({ type: 'ready' }),
      exit: new Promise(() => {}),
      async decode(call) {
        return workerResult(call, words([' текст', 1, 8]));
      },
      cancel() {
        cancels += 1;
        return barrier.promise;
      },
    },
    filePath: path.join(root, 'audio.pcm'),
    decodeIntervalMs: 100,
    maxWindowMs: 1_000,
    maxPendingMs: 1_000,
  });
  const events = [];
  session.on('event', (event) => events.push(event));
  await session.start();
  session.pushFrame(1, Buffer.alloc(320));
  const stopping = session.stop();
  await tick();
  assert.equal(session.snapshot().state, 'finishing');

  const cancelling = session.cancel();
  assert.equal(session.snapshot().state, 'cancelled');
  barrier.resolve(true);
  assert.equal(await cancelling, true);
  await assert.rejects(stopping, (error) => error.name === 'AbortError');
  await tick();
  assert.equal(cancels, 1);
  assert.equal(events.some((event) => event.type === 'final' || event.type === 'done'), false);
  assert.equal(session.snapshot().state, 'cancelled');
});

test('cancel удаляет raw и не выпускает поздний текст', async (t) => {
  const { session, calls, filePath, ...harness } = tempSession(t);
  const events = [];
  session.on('event', (event) => events.push(event));
  await session.start();
  session.pushFrame(1, Buffer.alloc(320));
  assert.equal(await session.cancel(), true);
  await tick();
  assert.equal(calls[0].call.signal.aborted, true);
  assert.equal(events.some((event) => ['partial', 'final', 'done', 'error'].includes(event.type)), false);
  assert.equal(harness.cancelCount(), 1);
  assert.equal(existsSync(filePath), false);
});

test('повторный cancel ждёт тот же process death barrier', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-speech-stream-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const barrier = deferred();
  let cancels = 0;
  const session = new SpeechStreamSession({
    controller: {
      ready: Promise.resolve({ type: 'ready' }),
      decode: async () => ({ window: {}, words: [] }),
      cancel() {
        cancels += 1;
        return barrier.promise;
      },
    },
    filePath: path.join(root, 'audio.pcm'),
  });
  await session.start();
  let secondSettled = false;
  const first = session.cancel();
  const second = session.cancel().then((value) => {
    secondSettled = true;
    return value;
  });
  await tick();
  assert.equal(secondSettled, false);
  assert.equal(cancels, 1, 'controller cancel тоже остаётся single-flight');
  barrier.resolve(true);
  assert.equal(await first, true);
  assert.equal(await second, false);
});

test('Python worker работает офлайн с local_files_only и абсолютными timestamps', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'grigdesk-stream-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modules = path.join(root, 'modules');
  const audio = path.join(root, 'audio.pcm');
  mkdirSync(modules);
  writeFileSync(audio, Buffer.alloc(640));
  writeFileSync(path.join(modules, 'huggingface_hub.py'), [
    'def snapshot_download(**kwargs):',
    "    assert kwargs['local_files_only'] is True",
    "    assert kwargs['revision'] == '0123456789012345678901234567890123456789'",
    "    return '/snapshot'",
  ].join('\n'));
  writeFileSync(path.join(modules, 'numpy.py'), [
    "float32 = 'float32'",
    'class Audio:',
    '    def astype(self, value): return self',
    '    def __truediv__(self, value): return self',
    'def frombuffer(value, dtype=None):',
    "    assert dtype == '<i2'",
    '    return Audio()',
  ].join('\n'));
  writeFileSync(path.join(modules, 'faster_whisper.py'), [
    'class Value:',
    '    def __init__(self, **values): self.__dict__.update(values)',
    'class WhisperModel:',
    '    def __init__(self, path, **kwargs):',
    "        assert path == '/snapshot'",
    "        assert kwargs['local_files_only'] is True",
    '    def transcribe(self, audio, **kwargs):',
    "        assert kwargs['word_timestamps'] is True",
    "        words = [Value(word=' тест', start=0.1, end=0.3)]",
    "        return iter([Value(text=' тест', start=0.1, end=0.3, words=words)]), Value(language='ru', language_probability=0.9)",
  ].join('\n'));
  const request = JSON.stringify({
    type: 'decode',
    requestId: 'decode-1',
    filePath: audio,
    startByte: 320,
    endByte: 640,
    offsetMs: 10,
    final: true,
  });
  const run = spawnSync('python3', [
    STREAM_WORKER_PY,
    '--nonce', 'worker-test',
    '--model', 'medium',
    '--model-repo', 'repo/model',
    '--model-revision', '0123456789012345678901234567890123456789',
  ], {
    env: { ...process.env, PYTHONPATH: modules },
    input: `${request}\n`,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const output = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(output[0].type, 'ready');
  assert.equal(output[0].protocolVersion, 1);
  assert.deepEqual(output[1].result.words, [{ startMs: 110, endMs: 310, text: ' тест' }]);
  assert.equal(output[1].result.window.offsetMs, 10);
});

test('worker source не ослабляет локальный pinned cache contract', () => {
  const source = readFileSync(STREAM_WORKER_PY, 'utf8');
  assert.match(source, /revision=args\.model_revision/);
  assert.match(source, /local_files_only=True/);
  assert.match(source, /word_timestamps=True/);
});

class FakeRuntimeStreamSession extends EventEmitter {
  constructor({ start = null } = {}) {
    super();
    this.startBehavior = start;
    this.currentState = 'starting';
    this.cancelCalls = 0;
    this.frames = [];
  }

  async start() {
    if (this.startBehavior) await this.startBehavior(this);
    this.currentState = 'recording';
    this.emit('event', {
      type: 'ready',
      protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
      audio: SPEECH_STREAM_AUDIO,
    });
  }

  pushFrame(seq, pcm) {
    this.frames.push({ seq, pcm });
    return { type: 'ack', ackSeq: seq };
  }

  async stop() {
    this.currentState = 'done';
    const result = {
      text: 'готовый текст',
      committed: 'готовый текст',
      partial: '',
      ackSeq: this.frames.at(-1)?.seq || 0,
      processedUntilMs: 100,
      receivedUntilMs: 100,
      lagMs: 0,
    };
    this.emit('event', { type: 'final', ...result });
    this.emit('event', { type: 'done', ...result });
    return result;
  }

  async cancel() {
    this.cancelCalls += 1;
    this.currentState = 'cancelled';
    return true;
  }

  snapshot() {
    return { state: this.currentState, lastSeq: this.frames.at(-1)?.seq || 0 };
  }
}

function runtimeModels() {
  return [{
    modelId: 'medium',
    repo: 'Systran/faster-whisper-medium',
    revision: '08e178d48790749d25932bbc082711ddcfdfbc4f',
    cached: true,
    sizeMb: 1,
  }];
}

function streamRuntimeHarness({
  maxStreams = 2,
  preflight = async () => ({ ok: true, checks: [], venvPython: '/venv/python' }),
  runCudaCanary = async () => ({ state: 'no_device', reason: 'нет GPU' }),
  createSession = () => new FakeRuntimeStreamSession(),
  ingestRecording = async () => ({ transcript: { segments: [] } }),
} = {}) {
  let sequence = 0;
  const created = [];
  const removed = [];
  const runtime = new SpeechRuntime({
    mediaDir: '/private/media',
    mediaHfDir: '/private/hf',
    pythonPath: '/venv/python',
    maxStreams,
    deps: {
      preflight,
      probeSpeechModelCache: async () => runtimeModels(),
      runCudaCanary,
      ingestRecording,
      mkdirSync() {},
      mkdtempSync(prefix) { return `${prefix}${++sequence}`; },
      rmSync(target, options) { removed.push({ target, options }); },
      randomUUID: () => `stream-${++sequence}`,
      createSpeechStreamSession(options) {
        const session = createSession(options, created.length);
        created.push({ options, session });
        return session;
      },
    },
  });
  return { runtime, created, removed };
}

test('runtime резервирует stream slot синхронно и снимает pending reservation по abort', async () => {
  const held = deferred();
  const { runtime, created } = streamRuntimeHarness({
    maxStreams: 1,
    preflight: () => held.promise,
  });
  const abort = new AbortController();
  const first = runtime.startStream({ signal: abort.signal });
  const second = runtime.startStream();
  await assert.rejects(second, (error) => error.code === 'speech_stream_busy');
  assert.equal(runtime.streams.size, 1, 'pending readiness уже занимает слот');

  abort.abort();
  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.equal(runtime.streams.size, 0);
  assert.equal(created.length, 0, 'после abort до readiness worker не запускается');
  held.resolve({ ok: true, checks: [], venvPython: '/venv/python' });
});

test('runtime отдаёт управляемый stream handle и чистит slot/workDir только после done', async () => {
  const { runtime, created, removed } = streamRuntimeHarness();
  const events = [];
  const handle = await runtime.startStream({
    settings: { model: 'medium', device: 'cpu', _revision: 'prefs-7' },
    optionsRevision: 'prefs-7',
    onEvent: (event) => events.push(event),
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].options.options.device, 'cpu');
  assert.equal(created[0].options.filePath.endsWith('/audio.pcm'), true);
  assert.equal(created[0].options.env.HF_HOME, '/private/hf');
  assert.equal(runtime.streams.size, 1);
  assert.equal(events[0].type, 'ready');
  assert.equal(events[0].sessionId, handle.streamId);
  assert.equal(events[0].optionsRevision, 'prefs-7');
  assert.deepEqual(events[0].audio, SPEECH_STREAM_AUDIO);

  const pcm = Buffer.alloc(320);
  assert.equal(handle.pushFrame(1, pcm).ackSeq, 1);
  assert.equal(handle.state, 'recording');
  const result = await handle.stop();
  assert.equal(result.text, 'готовый текст');
  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(runtime.streams.size, 0);
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].options, { recursive: true, force: true });
});

test('runtime делает auto CUDA→CPU только при CUDA-class failure загрузки stream worker', async () => {
  const sessions = [];
  const { runtime, created } = streamRuntimeHarness({
    runCudaCanary: async () => ({ state: 'ready', reason: null, device: 0 }),
    createSession(options, index) {
      const session = new FakeRuntimeStreamSession({
        start: index === 0
          ? async () => { throw new Error('CUDA out of memory while loading model'); }
          : null,
      });
      sessions.push(session);
      return session;
    },
  });
  const events = [];
  const handle = await runtime.startStream({
    settings: { model: 'medium', device: 'auto' },
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(created.map(({ options }) => ({
    device: options.options.device,
    computeType: options.options.computeType,
  })), [
    { device: 'cuda', computeType: 'float16' },
    { device: 'cpu', computeType: 'int8' },
  ]);
  assert.equal(sessions[0].cancelCalls, 1);
  assert.deepEqual(handle.execution, {
    engine: 'whisper',
    mode: 'stream',
    device: 'cpu',
    fallback: 'cuda_failed',
  });
  assert.equal(events.length, 1, 'CUDA-ошибка первой попытки не уходит клиенту перед retry');
  assert.equal(events[0].execution.fallback, 'cuda_failed');
  await handle.cancel();

  const explicit = streamRuntimeHarness({
    runCudaCanary: async () => ({ state: 'ready', reason: null, device: 0 }),
    createSession() {
      return new FakeRuntimeStreamSession({
        start: async () => { throw new Error('CUDA out of memory'); },
      });
    },
  });
  await assert.rejects(
    explicit.runtime.startStream({ settings: { model: 'medium', device: 'cuda' } }),
    /CUDA out of memory/,
  );
  assert.equal(explicit.created.length, 1, 'explicit CUDA не получает скрытый CPU retry');
  assert.equal(explicit.runtime.streams.size, 0);
  assert.equal(explicit.removed.length, 1);
});

test('abort cold start и shutdown активных streams ждут cancel и освобождают ресурсы', async () => {
  const coldStart = deferred();
  const cold = streamRuntimeHarness({
    createSession() {
      return new FakeRuntimeStreamSession({ start: () => coldStart.promise });
    },
  });
  const abort = new AbortController();
  const opening = cold.runtime.startStream({ signal: abort.signal });
  await tick();
  assert.equal(cold.created.length, 1);
  abort.abort();
  await assert.rejects(opening, (error) => error.name === 'AbortError');
  assert.equal(cold.created[0].session.cancelCalls, 1);
  assert.equal(cold.runtime.streams.size, 0);
  assert.equal(cold.removed.length, 1);
  coldStart.resolve();

  const active = streamRuntimeHarness({ maxStreams: 2 });
  const first = await active.runtime.startStream();
  const second = await active.runtime.startStream();
  assert.equal(active.runtime.streams.size, 2);
  await active.runtime.shutdown();
  assert.equal(active.runtime.streams.size, 0);
  assert.equal(active.created[0].session.cancelCalls, 1);
  assert.equal(active.created[1].session.cancelCalls, 1);
  assert.equal(active.removed.length, 2);
  await assert.rejects(active.runtime.startStream(), (error) => error.code === 'speech_unavailable');
  assert.equal(await first.cancel(), false);
  assert.equal(await second.cancel(), false);
});

test('runtime держит slot и workDir в quarantine до подтверждённого child close', async () => {
  const death = deferred();
  let ingests = 0;
  let session;
  const harness = streamRuntimeHarness({
    maxStreams: 1,
    createSession() {
      session = new FakeRuntimeStreamSession();
      session.deathConfirmed = false;
      session.cancel = async function cancel() {
        this.cancelCalls += 1;
        this.currentState = 'cancelled';
        throw Object.assign(new Error('child close не подтверждён'), { code: 'speech_unavailable' });
      };
      session.waitForDeath = () => death.promise.then(() => {
        session.deathConfirmed = true;
        return true;
      });
      return session;
    },
    async ingestRecording() {
      ingests += 1;
      return { transcript: { segments: [] } };
    },
  });
  const handle = await harness.runtime.startStream({ clientSessionId: 'quarantine-test' });

  await assert.rejects(handle.cancel(), (error) => error.code === 'speech_unavailable');
  assert.equal(harness.runtime.streams.size, 1);
  assert.equal(harness.removed.length, 0, 'raw/workDir остаются до process death barrier');
  await assert.rejects(
    harness.runtime.startStream({ clientSessionId: 'new-session' }),
    (error) => error.code === 'speech_stream_busy',
  );
  await assert.rejects(
    harness.runtime.transcribe({
      filePath: '/uncorrelated.webm',
      workDir: '/work/uncorrelated',
      settings: { model: 'medium', device: 'cpu' },
    }),
    (error) => error.code === 'speech_stream_busy',
  );
  assert.equal(ingests, 0, 'one-shot без correlation fail-closed при живом quarantine');

  await harness.runtime.shutdown();
  assert.equal(harness.runtime.streams.size, 1, 'shutdown bounded и не выдаёт живой slot');
  assert.equal(session.cancelCalls, 1, 'повторный shutdown использует тот же cancel promise');
  death.resolve();
  await tick();
  assert.equal(harness.runtime.streams.size, 0);
  assert.equal(harness.removed.length, 1);
});

test('runtime не теряет slot/workDir при initial process identity failure', async () => {
  const child = fakeChild(805);
  const timers = manualTimers();
  const controller = createSpeechStreamProcess({
    pythonPath: '/venv/python',
    options: { model: 'medium', device: 'cpu' },
    nonce: 'stream-runtime-no-identity',
    readyTimeoutMs: 10_000,
    killGraceMs: 5,
  }, {
    spawn() { return child; },
    readProcessIdentity() { return null; },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  let rawClosed = 0;
  let rawUnlinked = 0;
  const harness = streamRuntimeHarness({
    maxStreams: 1,
    createSession(options) {
      return new SpeechStreamSession({
        controller,
        filePath: options.filePath,
      }, {
        openSync: () => 77,
        fchmodSync() {},
        closeSync() { rawClosed += 1; },
        unlinkSync() { rawUnlinked += 1; },
      });
    },
  });

  const opening = harness.runtime.startStream({
    settings: { model: 'medium', device: 'cpu' },
    clientSessionId: 'initial-identity-failure',
  });
  for (let attempt = 0; attempt < 10 && harness.created.length === 0; attempt += 1) await tick();
  assert.equal(harness.created.length, 1);
  timers.runThrough(100);
  await assert.rejects(opening, (error) => error.code === 'speech_unavailable');
  assert.equal(harness.runtime.streams.size, 1);
  assert.equal(harness.removed.length, 0);
  assert.equal(rawClosed, 0);
  assert.equal(rawUnlinked, 0);

  child.emit('close', 1, null);
  await controller.exit;
  await tick();
  assert.equal(harness.runtime.streams.size, 0);
  assert.equal(harness.removed.length, 1);
  assert.equal(rawClosed, 1);
  assert.equal(rawUnlinked, 1);
});

test('batch fallback по client session id сам отменяет и ждёт exact live worker', async () => {
  const barrier = deferred();
  let ingests = 0;
  let session;
  const harness = streamRuntimeHarness({
    createSession() {
      session = new FakeRuntimeStreamSession();
      session.cancel = async function cancel() {
        this.cancelCalls += 1;
        await barrier.promise;
        this.currentState = 'cancelled';
        return true;
      };
      return session;
    },
    async ingestRecording() {
      ingests += 1;
      return { transcript: { segments: [] } };
    },
  });
  await harness.runtime.startStream({
    settings: { model: 'medium', device: 'cpu' },
    clientSessionId: 'dictation-correlated',
  });
  const fallback = harness.runtime.transcribe({
    filePath: '/full-recording.webm',
    workDir: '/work/fallback',
    settings: { model: 'medium', device: 'cpu' },
    streamSessionId: 'dictation-correlated',
  });
  await tick();
  assert.equal(session.cancelCalls, 1);
  assert.equal(ingests, 0, 'one-shot ждёт exact live session даже до WS close handler');
  barrier.resolve(true);
  await fallback;
  assert.equal(ingests, 1);
  assert.equal(harness.runtime.streams.size, 0);
});

test('batch fallback ждёт death barrier уже отменяемого stream worker', async () => {
  const barrier = deferred();
  let ingests = 0;
  const harness = streamRuntimeHarness({
    createSession() {
      const session = new FakeRuntimeStreamSession();
      session.cancel = async function cancel() {
        this.cancelCalls += 1;
        await barrier.promise;
        this.currentState = 'cancelled';
        return true;
      };
      return session;
    },
    async ingestRecording() {
      ingests += 1;
      return { transcript: { segments: [] } };
    },
  });
  const handle = await harness.runtime.startStream({ settings: { model: 'medium', device: 'cpu' } });
  const cancelling = handle.cancel();
  const fallback = harness.runtime.transcribe({
    filePath: '/full-recording.webm',
    workDir: '/work/fallback',
    settings: { model: 'medium', device: 'cpu' },
  });
  await tick();
  assert.equal(ingests, 0, 'one-shot не грузит вторую модель до смерти session worker');
  barrier.resolve(true);
  await cancelling;
  await fallback;
  assert.equal(ingests, 1);
});
