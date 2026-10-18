import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  createSpeechStream,
  encodeSpeechPcmPacket,
  SPEECH_PCM_FRAME_SAMPLES,
  SPEECH_PCM_SAMPLE_RATE,
  SPEECH_PCM_WORKLET_NAME,
  SPEECH_STREAM_AUDIO,
  SPEECH_STREAM_PROTOCOL_VERSION,
} from '../../web/src/shared/speech-stream.js';

const WORKLET_PATH = new URL('../../web/src/shared/speech-pcm-worklet.js', import.meta.url);
const STREAM_PATH = new URL('../../web/src/shared/speech-stream.js', import.meta.url);
const VITE_CONFIG_PATH = new URL('../../web/vite.config.js', import.meta.url);

function nextTurn() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function transportHarness({
  flushPcm = null,
  flushAck = true,
  deferredModule = null,
  deferredClose = null,
  deferredSocketClose = null,
} = {}) {
  const state = {
    sockets: [],
    contexts: [],
    workletNodes: [],
    sources: [],
    gains: [],
    trackStops: 0,
  };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closeCalls = [];
      state.sockets.push(this);
    }
    send(value) { this.sent.push(value); }
    close(code) {
      this.closeCalls.push(code);
      if (!deferredSocketClose) {
        this.readyState = 3;
        return;
      }
      this.readyState = 2;
      deferredSocketClose.promise.then(() => {
        this.readyState = 3;
        this.onclose?.();
      });
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    message(value) {
      this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
    }
    serverClose() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  class FakeAudioNode {
    constructor(bucket) {
      this.connections = [];
      this.disconnectCalls = 0;
      bucket.push(this);
    }
    connect(target) { this.connections.push(target); return target; }
    disconnect() { this.disconnectCalls += 1; }
  }

  class FakeSource extends FakeAudioNode {
    constructor() { super(state.sources); }
  }

  class FakeGain extends FakeAudioNode {
    constructor() {
      super(state.gains);
      this.gain = { value: 1 };
    }
  }

  class FakePort {
    constructor() {
      this.onmessage = null;
      this.started = false;
      this.closed = false;
      this.toWorklet = [];
    }
    start() { this.started = true; }
    close() { this.closed = true; }
    postMessage(message) {
      this.toWorklet.push(message);
      if (message?.type !== 'flush') return;
      queueMicrotask(() => {
        if (flushPcm) this.emitPcm(flushPcm);
        if (flushAck) this.onmessage?.({ data: { type: 'flushed' } });
      });
    }
    emitPcm(pcm) {
      const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm);
      this.onmessage?.({ data: { type: 'pcm', pcm: samples.buffer } });
    }
  }

  class FakeWorkletNode extends FakeAudioNode {
    constructor(context, name, options) {
      super(state.workletNodes);
      this.context = context;
      this.name = name;
      this.options = options;
      this.port = new FakePort();
    }
  }

  class FakeAudioContext {
    constructor() {
      this.destination = {};
      this.closeCalls = 0;
      this.resumeCalls = 0;
      this.loadedModules = [];
      this.audioWorklet = {
        addModule: async (url) => {
          this.loadedModules.push(url);
          if (deferredModule) await deferredModule.promise;
        },
      };
      state.contexts.push(this);
    }
    createMediaStreamSource() { return new FakeSource(); }
    createGain() { return new FakeGain(); }
    async resume() { this.resumeCalls += 1; }
    async close() {
      this.closeCalls += 1;
      if (deferredClose) await deferredClose.promise;
    }
  }

  const mediaStream = {
    getTracks: () => [{ stop: () => { state.trackStops += 1; } }],
  };
  const config = {
    mediaStream,
    sessionId: 'speech-session-1',
    revision: 'opaque-revision-1',
    apiClient: { wsUrl: (path) => `wss://grigdesk.test${path}` },
    WebSocketCtor: FakeSocket,
    AudioContextCtor: FakeAudioContext,
    AudioWorkletNodeCtor: FakeWorkletNode,
  };
  return { state, config };
}

async function openSession(harness, overrides = {}) {
  const opening = createSpeechStream({ ...harness.config, ...overrides });
  assert.equal(harness.state.sockets.length, 1);
  const socket = harness.state.sockets[0];
  socket.open();
  const start = JSON.parse(socket.sent[0]);
  assert.equal(start.type, 'start');
  assert.equal(start.sessionId, 'speech-session-1');
  assert.equal(start.revision, 'opaque-revision-1');
  assert.equal(start.protocolVersion, SPEECH_STREAM_PROTOCOL_VERSION);
  assert.deepEqual(start.audio, SPEECH_STREAM_AUDIO);
  socket.message({
    type: 'ready',
    protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
    audio: SPEECH_STREAM_AUDIO,
  });
  return { session: await opening, socket };
}

test('PCM packet имеет uint32 LE seq и не меняет исходный буфер', () => {
  const pcm = new Int16Array([-32768, 0, 32767]);
  const packet = encodeSpeechPcmPacket(0x01020304, pcm);
  assert.equal(packet.byteLength, 10);
  assert.equal(new DataView(packet).getUint32(0, true), 0x01020304);
  assert.deepEqual([...new Int16Array(packet, 4)], [...pcm]);
  assert.throws(() => encodeSpeechPcmPacket(0, pcm), /seq/);
  assert.throws(() => encodeSpeechPcmPacket(1, new Uint8Array(3)), /16-битных/);
});

test('live transport ждёт ready, шлёт PCM по seq и делает bounded Stop с tail до control', async () => {
  const tail = new Int16Array([31, 32, 33]);
  const harness = transportHarness({ flushPcm: tail });
  const events = [];
  const { session, socket } = await openSession(harness, {
    onEvent: (event) => events.push(event),
  });

  assert.equal(session.state, 'recording');
  assert.equal(socket.url, 'wss://grigdesk.test/api/chat/transcribe/stream');
  assert.equal(harness.state.contexts[0].loadedModules.length, 1);
  assert.equal(harness.state.workletNodes[0].name, SPEECH_PCM_WORKLET_NAME);
  assert.deepEqual(harness.state.workletNodes[0].options.processorOptions, {
    targetSampleRate: SPEECH_PCM_SAMPLE_RATE,
    frameSamples: SPEECH_PCM_FRAME_SAMPLES,
  });
  assert.equal(harness.state.gains[0].gain.value, 0);

  const first = new Int16Array([11, 12]);
  harness.state.workletNodes[0].port.emitPcm(first);
  const firstPacket = socket.sent.find((value) => value instanceof ArrayBuffer);
  assert.equal(new DataView(firstPacket).getUint32(0, true), 1);
  assert.deepEqual([...new Int16Array(firstPacket, 4)], [...first]);
  socket.message({ type: 'ack', seq: 1, ackSeq: 1, receivedUntilMs: 100 });
  socket.message({ type: 'partial', text: 'проверка', partial: 'проверка' });

  const stopping = session.stop();
  await nextTurn();
  const tailIndex = socket.sent.findIndex((value) => value instanceof ArrayBuffer
    && new DataView(value).getUint32(0, true) === 2);
  const stopIndex = socket.sent.findIndex((value) => typeof value === 'string'
    && JSON.parse(value).type === 'stop');
  assert.ok(tailIndex >= 0, 'неполный worklet-frame ушёл последним PCM-пакетом');
  assert.ok(stopIndex > tailIndex, 'control stop идёт строго после PCM tail');
  assert.deepEqual(JSON.parse(socket.sent[stopIndex]), { type: 'stop', seq: 2 });

  socket.message({ type: 'final', text: 'проверка хвоста' });
  socket.message({ type: 'done', text: 'проверка хвоста' });
  const result = await stopping;
  assert.equal(result.text, 'проверка хвоста');
  assert.deepEqual(events.map((event) => event.type), ['ready', 'ack', 'partial', 'final', 'done']);
  assert.equal(session.state, 'done');
  assert.equal(harness.state.contexts[0].closeCalls, 1);
  assert.equal(harness.state.sources[0].disconnectCalls, 1);
  assert.equal(harness.state.workletNodes[0].port.closed, true);
  assert.equal(harness.state.trackStops, 0, 'MediaStream остаётся владельцу для batch fallback');
});

test('cold start не теряет начало: PCM копится до ready и уходит после version gate', async () => {
  const harness = transportHarness();
  const opening = createSpeechStream(harness.config);
  const socket = harness.state.sockets[0];
  socket.open();
  await nextTurn();
  assert.equal(harness.state.workletNodes.length, 1, 'AudioWorklet не ждёт загрузку модели');

  harness.state.workletNodes[0].port.emitPcm(new Int16Array([71, 72]));
  assert.equal(socket.sent.filter((value) => value instanceof ArrayBuffer).length, 0,
    'PCM не нарушает handshake и остаётся в bounded queue');
  socket.message({
    type: 'ready',
    protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
    audio: SPEECH_STREAM_AUDIO,
  });
  const session = await opening;
  const packet = socket.sent.find((value) => value instanceof ArrayBuffer);
  assert.equal(new DataView(packet).getUint32(0, true), 1);
  assert.deepEqual([...new Int16Array(packet, 4)], [71, 72]);
  await session.cancel();
});

test('cancel закрывает свои ресурсы, выбрасывает очередь и не останавливает MediaStream', async () => {
  const harness = transportHarness();
  const { session, socket } = await openSession(harness);
  harness.state.workletNodes[0].port.emitPcm(new Int16Array([1, 2]));
  await session.cancel();

  assert.equal(session.state, 'cancelled');
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'cancel');
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.state.contexts[0].closeCalls, 1);
  assert.equal(harness.state.trackStops, 0);
  await assert.rejects(session.stop(), { name: 'AbortError' });
});

test('backpressure/обрыв не reconnect-ятся и явно переводят поток в fallback', async () => {
  for (const scenario of ['backpressure', 'close']) {
    const harness = transportHarness();
    const errors = [];
    const { session, socket } = await openSession(harness, {
      maxBufferedBytes: 7,
      onError: (error) => errors.push(error),
    });
    if (scenario === 'backpressure') {
      // 4 байта заголовка + 4 байта PCM превышают тестовый предел.
      harness.state.workletNodes[0].port.emitPcm(new Int16Array([1, 2]));
    } else {
      socket.serverClose();
    }
    await nextTurn();
    assert.equal(session.state, 'failed');
    assert.equal(errors.length, 1);
    assert.equal(harness.state.sockets.length, 1, 'скрытого reconnect нет');
    await assert.rejects(session.stop(), (error) => {
      if (scenario === 'backpressure') assert.equal(error.code, 'speech_stream_backpressure');
      return true;
    });
    assert.equal(harness.state.trackStops, 0);
  }
});

test('cancel во время addModule не создаёт node в уже закрытом AudioContext', async () => {
  let releaseModule;
  const modulePromise = new Promise((resolve) => { releaseModule = resolve; });
  const controller = new AbortController();
  const harness = transportHarness({ deferredModule: { promise: modulePromise } });
  const opening = createSpeechStream({ ...harness.config, signal: controller.signal });
  const socket = harness.state.sockets[0];
  socket.open();
  socket.message({
    type: 'ready',
    protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
    audio: SPEECH_STREAM_AUDIO,
  });
  await Promise.resolve();
  controller.abort();
  releaseModule();

  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(harness.state.workletNodes.length, 0);
  assert.equal(harness.state.contexts[0].closeCalls, 1);
  assert.equal(harness.state.trackStops, 0);
});

test('cancel во время addModule не завершает open до закрытия AudioContext', async () => {
  let releaseModule;
  let releaseClose;
  const moduleGate = new Promise((resolve) => { releaseModule = resolve; });
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const controller = new AbortController();
  const harness = transportHarness({
    deferredModule: { promise: moduleGate },
    deferredClose: { promise: closeGate },
  });
  const opening = createSpeechStream({
    ...harness.config,
    signal: controller.signal,
    audioCloseTimeoutMs: 500,
  });
  const socket = harness.state.sockets[0];
  socket.open();
  socket.message({
    type: 'ready',
    protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION,
    audio: SPEECH_STREAM_AUDIO,
  });
  await Promise.resolve();
  controller.abort();
  releaseModule();
  let settled = false;
  let rejected = null;
  const observed = opening.catch((error) => {
    settled = true;
    rejected = error;
  });

  await delay(20);
  assert.equal(settled, false);
  releaseClose();
  await observed;
  assert.equal(rejected?.name, 'AbortError');
  assert.equal(harness.state.workletNodes.length, 0);
});

test('нет flush ack — Stop завершается ошибкой и оставляет recording для batch fallback', async () => {
  const harness = transportHarness({ flushAck: false });
  const errors = [];
  const { session } = await openSession(harness, {
    workletFlushTimeoutMs: 5,
    onError: (error) => errors.push(error),
  });
  await assert.rejects(session.stop(), (error) => {
    assert.equal(error.code, 'speech_stream_flush_timeout');
    return true;
  });
  await nextTurn();
  assert.equal(session.state, 'failed');
  assert.equal(errors.length, 1);
  assert.equal(harness.state.trackStops, 0);
});

test('ошибка Stop видна вызывающему только после bounded transport cleanup', async () => {
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const harness = transportHarness({
    flushAck: false,
    deferredClose: { promise: closeGate },
  });
  const errors = [];
  const { session } = await openSession(harness, {
    workletFlushTimeoutMs: 5,
    audioCloseTimeoutMs: 500,
    onError: (error) => errors.push(error),
  });
  let settled = false;
  let rejected = null;
  const stopping = session.stop().catch((error) => {
    rejected = error;
    settled = true;
  });

  await delay(20);
  assert.equal(settled, false, 'batch fallback ещё не должен стартовать до cleanup');
  assert.equal(errors.length, 0);
  releaseClose();
  await stopping;
  assert.equal(rejected?.code, 'speech_stream_flush_timeout');
  assert.equal(errors.length, 1);
});

test('Stop + cancel во время worklet flush дают AbortError и общий cleanup barrier', async () => {
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const harness = transportHarness({
    flushAck: false,
    deferredClose: { promise: closeGate },
  });
  const { session } = await openSession(harness, {
    workletFlushTimeoutMs: 500,
    audioCloseTimeoutMs: 500,
  });
  const stopping = session.stop();
  await nextTurn();
  let firstDone = false;
  let secondDone = false;
  const firstCancel = session.cancel().then(() => { firstDone = true; });
  const secondCancel = session.cancel().then(() => { secondDone = true; });

  await delay(20);
  assert.equal(firstDone, false);
  assert.equal(secondDone, false, 'повторный cancel ждёт тот же socket/audio cleanup');
  releaseClose();
  await Promise.all([firstCancel, secondCancel]);
  assert.equal(session.state, 'cancelled');
  await assert.rejects(stopping, { name: 'AbortError', code: 'speech_stream_cancelled' });
});

test('cancel после flush не завершает Stop раньше socket close barrier', async () => {
  let releaseAudio;
  let releaseSocket;
  const audioGate = new Promise((resolve) => { releaseAudio = resolve; });
  const socketGate = new Promise((resolve) => { releaseSocket = resolve; });
  const harness = transportHarness({
    deferredClose: { promise: audioGate },
    deferredSocketClose: { promise: socketGate },
  });
  const { session } = await openSession(harness, {
    audioCloseTimeoutMs: 500,
    socketCloseTimeoutMs: 500,
  });
  let rejected = null;
  const stopping = session.stop().catch((error) => { rejected = error; });
  await nextTurn();
  const cancelling = session.cancel();
  releaseAudio();
  await delay(20);
  assert.equal(rejected, null, 'Stop ждёт ещё не закрытый WebSocket');
  releaseSocket();
  await Promise.all([stopping, cancelling]);
  assert.equal(rejected?.name, 'AbortError');
});

test('зависший AudioContext.close ограничен и не удерживает cancel/fallback', async () => {
  const never = new Promise(() => {});
  const harness = transportHarness({ deferredClose: { promise: never } });
  const { session, socket } = await openSession(harness, { audioCloseTimeoutMs: 5 });
  socket.serverClose();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(session.state, 'failed');
  await session.cancel();
  assert.equal(session.state, 'cancelled');
  assert.equal(harness.state.contexts[0].closeCalls, 1);
});

test('несовместимый ready fail-closed, PCM не отправляется', async () => {
  const harness = transportHarness();
  const errors = [];
  const opening = createSpeechStream({
    ...harness.config,
    onError: (error) => errors.push(error),
  });
  const socket = harness.state.sockets[0];
  socket.open();
  socket.message({
    type: 'ready',
    protocolVersion: SPEECH_STREAM_PROTOCOL_VERSION + 1,
    audio: SPEECH_STREAM_AUDIO,
  });
  await assert.rejects(opening, { code: 'speech_stream_protocol' });
  assert.equal(errors.length, 1);
  assert.equal(socket.sent.filter((value) => value instanceof ArrayBuffer).length, 0);
  assert.equal(harness.state.trackStops, 0);
});

test('AudioWorklet ресемплирует 48 кГц в PCM16 16 кГц и flush отдаёт хвост', async (t) => {
  const registered = {};
  class FakeAudioWorkletProcessor {
    constructor() {
      this.messages = [];
      this.port = {
        onmessage: null,
        postMessage: (message) => { this.messages.push(message); },
      };
    }
  }
  for (const [key, value] of Object.entries({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    sampleRate: 48000,
    registerProcessor: (name, Processor) => { registered[name] = Processor; },
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { delete globalThis[key]; });
  }
  await import(`${WORKLET_PATH.href}?test=${Date.now()}`);
  const Processor = registered[SPEECH_PCM_WORKLET_NAME];
  assert.equal(typeof Processor, 'function');

  const processor = new Processor({
    processorOptions: { targetSampleRate: 16000, frameSamples: 1600 },
  });
  processor.process([[new Float32Array(4800).fill(0.5)]], [[new Float32Array(128)]]);
  const frame = processor.messages.find((message) => message.type === 'pcm');
  assert.equal(new Int16Array(frame.pcm).length, 1600);
  assert.ok(Math.abs(new Int16Array(frame.pcm)[0] - 16384) <= 1);

  const tailProcessor = new Processor({
    processorOptions: { targetSampleRate: 16000, frameSamples: 1600 },
  });
  tailProcessor.process([[new Float32Array(480).fill(-0.5)]], [[new Float32Array(128)]]);
  assert.equal(tailProcessor.messages.length, 0, 'до flush неполный 100-мс frame буферизован');
  tailProcessor.port.onmessage({ data: { type: 'flush' } });
  assert.deepEqual(tailProcessor.messages.map((message) => message.type), ['pcm', 'flushed']);
  assert.ok(new Int16Array(tailProcessor.messages[0].pcm).length >= 159);
});

test('Vite dev proxy пропускает WebSocket upgrade для /api', async () => {
  const source = await readFile(VITE_CONFIG_PATH, 'utf8');
  assert.match(source, /['"]\/api['"]:\s*\{[^}]*\bws:\s*true\b/);
  assert.match(source, /['"]\/api['"]:\s*\{[^}]*\brewriteWsOrigin:\s*true\b/);
});

test('production transport limits закреплены ниже серверного rolling window', async () => {
  const source = await readFile(STREAM_PATH, 'utf8');
  assert.match(source, /DEFAULT_READY_TIMEOUT_MS\s*=\s*45000/);
  assert.match(source, /DEFAULT_DRAIN_TIMEOUT_MS\s*=\s*30000/);
  assert.match(source, /DEFAULT_MAX_BUFFERED_BYTES\s*=\s*768\s*\*\s*1024/);
  assert.match(source, /DEFAULT_AUDIO_CLOSE_TIMEOUT_MS\s*=\s*750/);
  assert.match(source, /DEFAULT_SOCKET_CLOSE_TIMEOUT_MS\s*=\s*750/);
});
