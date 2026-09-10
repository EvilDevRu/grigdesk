import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SpeechRuntime } from '../../server/src/lib/speech/index.ts';
import chatModule from '../../server/src/modules/chat/index.ts';
import mediaModule from '../../server/src/modules/media/index.ts';
import authPlugin, { SESSION_COOKIE } from '../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const multipartPlugin = requireFromServer('@fastify/multipart');
const websocketPlugin = requireFromServer('@fastify/websocket');
const WebSocket = requireFromServer('ws');

const STREAM_AUDIO = Object.freeze({
  encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1, frameSamples: 1_600,
});

function multipartFile(content = 'fake audio', filename = 'dictation.webm', fields = {}) {
  const boundary = `----cockpit-speech-${Math.random().toString(16).slice(2)}`;
  const fieldParts = Object.entries(fields).flatMap(([name, value]) => [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"`,
    '',
    String(value),
  ]);
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from([
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: audio/webm',
      '',
      content,
      ...fieldParts,
      `--${boundary}--`,
      '',
    ].join('\r\n')),
  };
}

function speechSettings() {
  return {
    engine: 'whisper',
    browserProcessing: 'auto',
    browserAutoConsent: false,
    language: 'en',
    dictionary: 'Fastify',
    quality: 'accurate',
    videoQuality: 'fast',
    model: null,
    videoModel: null,
    device: 'cpu',
    computeType: 'int8',
    beamSize: null,
    vadSilenceMs: 700,
    conditionOnPreviousText: false,
    resident: false,
    keepAliveMin: 5,
  };
}

async function chatFixture(t, {
  runtimeFactory = null,
  withAuth = false,
  speechStreamStartTimeoutMs = null,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-http-'));
  const settings = speechSettings();
  const revision = 'speech:11111111-1111-4111-8111-111111111111';
  let transcribeError = null;
  let transcribeHook = null;
  let captured = null;
  let capturedWarmup = null;
  let cancelledWarmup = null;
  let streamFactory = null;
  let capturedStream = null;
  let asyncSnapshotCalls = 0;
  const publicSnapshot = (value) => ({
    engine: value.engine,
    browserProcessing: value.browserProcessing,
    browserAutoConsent: value.browserAutoConsent,
    language: value.language,
    dictionary: value.dictionary,
    local: { ready: true, reason: null },
  });
  const fakeSpeechRuntime = {
    async transcribe(options) {
      captured = { ...options, fileExisted: existsSync(options.filePath) };
      if (transcribeError) throw transcribeError;
      if (transcribeHook) return transcribeHook(options);
      return {
        transcript: {
          duration: 1.25,
          hotwordsTokens: 3,
          hotwordsTruncated: false,
          segments: [{ text: 'hello cockpit' }],
        },
      };
    },
    publicSnapshot,
    async publicSnapshotAsync(value) {
      asyncSnapshotCalls += 1;
      return publicSnapshot(value);
    },
    async warmup(options) {
      capturedWarmup = options;
      return { warmupId: 'warm-1', expiresAt: '2026-08-08T12:00:00.000Z' };
    },
    async cancelWarmup(warmupId) {
      cancelledWarmup = warmupId;
      return warmupId === 'warm-1';
    },
    async startStream(options) {
      capturedStream = options;
      if (!streamFactory) throw Object.assign(new Error('stream unavailable'), { code: 'speech_unavailable' });
      return streamFactory(options);
    },
  };
  const speechRuntime = runtimeFactory ? runtimeFactory(root) : fakeSpeechRuntime;
  const prefs = {
    read() {
      return {
        speech: settings,
        trustedDirectories: [],
        providerSettings: {},
        chatAutoCompactWindow: 0,
      };
    },
    readStored() { return { speech: { ...settings, _revision: revision } }; },
  };
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  await app.register(multipartPlugin);
  await app.register(websocketPlugin, { options: { maxPayload: 1024 ** 2 } });
  if (withAuth) {
    await app.register(authPlugin, {
      authStore: {
        isConfigured: () => true,
        isValidSession: (sid) => sid === 'valid-speech-session',
      },
      tlsEnabled: false,
      trustProxy: false,
      internalToken: '',
      cliToken: '',
    });
  }
  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      agentsDir: path.join(root, 'agents'),
      port: 18140,
    },
    factoryState: { async readEnv() { return {}; } },
    prefs,
    speechRuntime,
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({}),
    ...(speechStreamStartTimeoutMs ? { speechStreamStartTimeoutMs } : {}),
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    app,
    captured: () => captured,
    capturedWarmup: () => capturedWarmup,
    cancelledWarmup: () => cancelledWarmup,
    capturedStream: () => capturedStream,
    asyncSnapshotCalls: () => asyncSnapshotCalls,
    failWith(error) { transcribeError = error; },
    onTranscribe(hook) { transcribeHook = hook; },
    onStream(factory) { streamFactory = factory; },
    revision,
  };
}

function speechStart(revision, extra = {}) {
  return {
    type: 'start',
    protocolVersion: 1,
    sessionId: 'dictation-test-1',
    revision,
    audio: STREAM_AUDIO,
    ...extra,
  };
}

function pcmPacket(seq, samples) {
  const packet = Buffer.alloc(4 + samples.length * 2);
  packet.writeUInt32LE(seq, 0);
  samples.forEach((sample, index) => packet.writeInt16LE(sample, 4 + index * 2));
  return packet;
}

async function speechSocket(app, { origin: customOrigin } = {}) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  const origin = customOrigin || `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/chat/transcribe/stream`, { origin });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, origin, port };
}

function jsonInbox(socket) {
  const queued = [];
  const waiting = [];
  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString('utf8'));
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  });
  return {
    next(timeoutMs = 1_000) {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) {
            clearTimeout(waiter.timer);
            resolve(value);
          },
          timer: null,
        };
        waiter.timer = setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error('Не получено ожидаемое WS-событие речи'));
        }, timeoutMs);
        waiting.push(waiter);
      });
    },
  };
}

test('speech WebSocket передаёт PCM без seq-заголовка и завершает final ровно один раз', async (t) => {
  const fixture = await chatFixture(t);
  const frames = [];
  let stopCalls = 0;
  let cancelCalls = 0;
  let lastSeq = 0;
  fixture.onStream((options) => {
    options.onEvent({ type: 'ready', protocolVersion: 1, audio: STREAM_AUDIO });
    return {
      pushFrame(seq, pcm) {
        lastSeq = seq;
        frames.push({ seq, pcm: Buffer.from(pcm) });
        options.onEvent({ type: 'ack', seq, ackSeq: seq, receivedUntilMs: pcm.length / 32 });
      },
      snapshot: () => ({ lastSeq }),
      async stop() {
        stopCalls += 1;
        const result = {
          text: 'hello live', committed: 'hello live', partial: '', ackSeq: lastSeq,
          processedUntilMs: 100, receivedUntilMs: 100, lagMs: 0,
        };
        options.onEvent({ type: 'final', ...result });
        options.onEvent({ type: 'done', ...result });
        return result;
      },
      async cancel() { cancelCalls += 1; },
    };
  });

  const { socket } = await speechSocket(fixture.app);
  t.after(() => socket.terminate());
  const inbox = jsonInbox(socket);
  socket.send(JSON.stringify(speechStart(fixture.revision)));
  const ready = await inbox.next();
  assert.deepEqual(ready.audio, STREAM_AUDIO);
  assert.equal(ready.protocolVersion, 1);
  assert.equal(ready.optionsRevision, fixture.revision);
  assert.equal(fixture.capturedStream().optionsRevision, fixture.revision);
  assert.equal(fixture.capturedStream().clientSessionId, 'dictation-test-1');
  assert.equal(fixture.capturedStream().settings.quality, 'accurate');

  socket.send(pcmPacket(1, [100, -200]));
  const ack = await inbox.next();
  assert.equal(ack.type, 'ack');
  assert.equal(ack.ackSeq, 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].seq, 1);
  assert.deepEqual([...frames[0].pcm], [100, 0, 56, 255]);

  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.send(JSON.stringify({ type: 'stop', seq: 1 }));
  const final = await inbox.next();
  const done = await inbox.next();
  assert.equal(final.type, 'final');
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'hello live');
  await closed;
  assert.equal(stopCalls, 1);
  assert.equal(cancelCalls, 0, 'close после done не отменяет уже завершённую сессию');
});

test('speech WebSocket fail-closed отклоняет stale revision и санитизирует runtime error', async (t) => {
  const fixture = await chatFixture(t);
  const first = await speechSocket(fixture.app);
  t.after(() => first.socket.terminate());
  const firstInbox = jsonInbox(first.socket);
  first.socket.send(JSON.stringify(speechStart('speech:22222222-2222-4222-8222-222222222222')));
  const stale = await firstInbox.next();
  assert.equal(stale.type, 'error');
  assert.equal(stale.code, 'stale_speech_settings');
  assert.equal(fixture.capturedStream(), null);

  fixture.onStream(() => {
    throw Object.assign(new Error('SECRET /home/private/model.bin'), { code: 'speech_model_missing' });
  });
  const second = await speechSocket(fixture.app);
  t.after(() => second.socket.terminate());
  const secondInbox = jsonInbox(second.socket);
  second.socket.send(JSON.stringify(speechStart(fixture.revision, { sessionId: 'dictation-test-2' })));
  const unavailable = await secondInbox.next();
  assert.equal(unavailable.type, 'error');
  assert.equal(unavailable.code, 'speech_model_missing');
  assert.match(unavailable.message, /не установлена/i);
  assert.doesNotMatch(JSON.stringify(unavailable), /SECRET|\/home\/private/);
});

test('speech WebSocket требует канонический exact Origin до upgrade', async (t) => {
  const fixture = await chatFixture(t);
  await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const port = fixture.app.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/chat/transcribe/stream`, {
    origin: `http://127.0.0.1:${port}/not-an-origin`,
  });
  socket.on('error', () => {});
  const status = await new Promise((resolve, reject) => {
    socket.once('open', () => reject(new Error('WebSocket с неверным Origin неожиданно открыт')));
    socket.once('unexpected-response', (_request, response) => {
      const result = response.statusCode;
      response.resume();
      resolve(result);
    });
  });
  assert.equal(status, 403);
  assert.equal(fixture.capturedStream(), null);
});

test('speech WebSocket закрыт общей session-auth и открывается с валидной cookie', async (t) => {
  const fixture = await chatFixture(t, { withAuth: true });
  await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const port = fixture.app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/api/chat/transcribe/stream`;

  const anonymousStatus = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('Анонимный speech WebSocket неожиданно открыт')));
    socket.once('error', reject);
  });
  assert.equal(anonymousStatus, 401);

  const authorized = new WebSocket(url, {
    origin,
    headers: { cookie: `${SESSION_COOKIE}=valid-speech-session` },
  });
  await new Promise((resolve, reject) => {
    authorized.once('open', resolve);
    authorized.once('error', reject);
  });
  authorized.close(1000, 'test complete');
  await new Promise((resolve) => authorized.once('close', resolve));
});

test('speech WebSocket отменяет поздний session handle после обрыва на cold start', async (t) => {
  const fixture = await chatFixture(t);
  let resolveStart;
  let signalAborted = false;
  let cancelCalls = 0;
  let markStarted;
  let markAborted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  fixture.onStream(({ signal }) => {
    markStarted();
    signal.addEventListener('abort', () => {
      signalAborted = true;
      markAborted();
    }, { once: true });
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  const { socket } = await speechSocket(fixture.app);
  socket.send(JSON.stringify(speechStart(fixture.revision)));
  await started;
  socket.terminate();
  await aborted;
  assert.equal(signalAborted, true);
  resolveStart({
    pushFrame() {},
    snapshot: () => ({ lastSeq: 0 }),
    stop: async () => {},
    async cancel() { cancelCalls += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 1, 'поздно созданный worker не остаётся сиротой');
});

test('speech WebSocket закрывает соединение, не приславшее start до deadline', async (t) => {
  const fixture = await chatFixture(t, { speechStreamStartTimeoutMs: 20 });
  const { socket } = await speechSocket(fixture.app);
  t.after(() => socket.terminate());
  const inbox = jsonInbox(socket);
  const event = await inbox.next();
  assert.equal(event.type, 'error');
  assert.equal(event.code, 'speech_stream_timeout');
  assert.equal(fixture.capturedStream(), null);
  await new Promise((resolve) => socket.once('close', resolve));
});

test('chat snapshot и multipart-транскрипция идут через один SpeechRuntime', async (t) => {
  const fixture = await chatFixture(t);
  const store = await fixture.app.inject({ method: 'GET', url: '/api/chat/store' });
  assert.equal(store.statusCode, 200);
  assert.deepEqual(store.json().speech, {
    engine: 'whisper',
    browserProcessing: 'auto',
    browserAutoConsent: false,
    language: 'en',
    dictionary: 'Fastify',
    local: { ready: true, reason: null },
    revision: fixture.revision,
  });
  assert.equal(fixture.asyncSnapshotCalls(), 0, 'chat store не ждёт async readiness probe');

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/transcribe',
    ...multipartFile('fake audio', 'dictation.webm', { streamSessionId: 'dictation-test-1' }),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    text: 'hello cockpit',
    duration: 1.25,
    diagnostics: { hotwordsTokens: 3, hotwordsTruncated: false },
    execution: { engine: 'whisper', mode: 'one-shot' },
  });
  assert.equal(fixture.captured().settings.quality, 'accurate');
  assert.equal(fixture.captured().settings.language, 'en');
  assert.equal(fixture.captured().fileExisted, true);
  assert.equal(fixture.captured().streamSessionId, 'dictation-test-1');
  assert.match(path.basename(fixture.captured().workDir), /^cockpit-dictate-/);
});

test('chat API прогревает runtime, передаёт warmupId и умеет отменить прогрев', async (t) => {
  const fixture = await chatFixture(t);
  const warmup = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/transcribe/warmup',
  });
  assert.equal(warmup.statusCode, 202, warmup.body);
  assert.deepEqual(warmup.json(), {
    warmupId: 'warm-1',
    expiresAt: '2026-08-08T12:00:00.000Z',
  });
  assert.equal(fixture.capturedWarmup().settings.quality, 'accurate');
  assert.equal(fixture.capturedWarmup().optionsRevision, fixture.revision);

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/transcribe',
    ...multipartFile('fake audio', 'dictation.webm', { warmupId: 'warm-1' }),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(fixture.captured().warmupId, 'warm-1');

  const cancelled = await fixture.app.inject({
    method: 'DELETE',
    url: '/api/chat/transcribe/warmup/warm-1',
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.deepEqual(cancelled.json(), { warmupId: 'warm-1', cancelled: true });
  assert.equal(fixture.cancelledWarmup(), 'warm-1');
});

test('закрытие HTTP response после принятого multipart отменяет runtime', async (t) => {
  const fixture = await chatFixture(t);
  let startedResolve;
  let abortedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const aborted = new Promise((resolve) => { abortedResolve = resolve; });
  fixture.onTranscribe(({ signal }) => new Promise((resolve, reject) => {
    startedResolve();
    signal.addEventListener('abort', () => {
      abortedResolve();
      reject(Object.assign(new Error('client disconnected'), { name: 'AbortError' }));
    }, { once: true });
  }));
  await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  const port = fixture.app.server.address().port;
  const multipart = multipartFile();
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/api/chat/transcribe`, {
    method: 'POST',
    headers: multipart.headers,
    body: multipart.payload,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(request, (error) => error?.name === 'AbortError');
  await aborted;
});

test('chat API сохраняет публичный код отсутствующей модели', async (t) => {
  const fixture = await chatFixture(t);
  const error = new Error('Сначала скачайте модель');
  error.code = 'speech_model_missing';
  fixture.failWith(error);
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/transcribe',
    ...multipartFile(),
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: 'speech_model_missing',
    message: 'Сначала скачайте модель',
  });
});

test('реальный SpeechRuntime отдаёт HTTP 409 при cache miss выбранной модели', async (t) => {
  const fixture = await chatFixture(t, {
    runtimeFactory: (root) => new SpeechRuntime({
      mediaDir: path.join(root, 'media'),
      deps: {
        preflight: async () => ({ ok: true, checks: [], venvPython: '/venv/python' }),
        probeSpeechModelCache: async () => [],
      },
    }),
  });
  const warmup = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/transcribe/warmup',
  });
  assert.equal(warmup.statusCode, 409, warmup.body);
  assert.equal(warmup.json().error, 'speech_model_missing');

  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/transcribe',
    ...multipartFile(),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'speech_model_missing');
  assert.match(response.json().message, /large-v3-turbo/);
});

test('живой media upload читает video speech settings', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cockpit-speech-media-http-'));
  let captured = null;
  const media = {
    mediaDir: root,
    // Каталоги хранилища объявляет адаптер: оттуда их берут и загрузка, и уборка.
    uploadsDir: path.join(root, 'uploads'),
    jobsDir: path.join(root, 'jobs'),
    ingest(options) { captured = options; return { jobId: 'job-speech' }; },
    doctor() { return { ok: true }; },
    status() { return null; },
    extractFrames() { return []; },
  };
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => true);
  await app.register(multipartPlugin);
  await app.register(mediaModule, { media, speechSettings });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/media/upload',
    ...multipartFile('fake video', 'meeting.webm'),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().jobId, 'job-speech');
  assert.equal(captured.settings.videoQuality, 'fast');
  assert.equal(captured.settings.language, 'en');
  assert.equal('model' in captured, false, 'upload использует server-owned video settings');
});
