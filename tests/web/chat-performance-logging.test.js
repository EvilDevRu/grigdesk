import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';
import { useBoardStore } from '../../web/src/stores/board.ts';
import { createWebLog } from '../../web/src/shared/webLog.ts';
import {
  createChatPerformanceRecorder,
  flushChatPerformance,
  installChatPerformance,
  measureChatPerformance,
} from '../../web/src/shared/chatPerformance.ts';

/**
 * Часы управляются тестом; журнал использует настоящую проекцию и общую политику.
 * Реальные таймеры и observers здесь не нужны для проверки сводок и приватности.
 */
function fixture(level = 'verbose') {
  let clock = 0;
  const now = () => clock;
  const log = createWebLog({
    now: () => new Date(1_700_000_000_000 + clock),
    monotonicNow: now,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: '/chats',
      vis: 'visible',
      boot: null,
    }),
    level,
  });
  const emit = (event, data) => log.record(event, data);

  return {
    log,
    now,
    emit,
    at: (value) => {
      clock = value;
    },
  };
}

test('разбор обычного и потокового JSON и применение доски не раскрывают путь или тело', async (t) => {
  const f = fixture();
  const doc = new EventTarget();

  doc.visibilityState = 'visible';

  const stop = installChatPerformance({
    log: f.log,
    win: { performance: { now: f.now } },
    doc,
    view: () => '/chats',
    afterFlush: (callback) => callback(),
  });

  t.after(stop);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const body = String(url).includes('/api/trackers') ? {
      externalId: 'fixture',
        revision: 1,
    } : String(url).includes('/api/tracker/dashboard') ? { tasks: [] }
      : String(url).includes('/api/tracker/task-seen') ? {
        scope: 'fixture',
        revision: 1,
        initialized: true,
        taskIds: [],
      } : { value: 'private-body' };

    return new Response(JSON.stringify(body));
  });
  await api.get('/api/providers?token=private-token');
  await api.get('/api/providers', { idleTimeoutMs: 30000 });
  await api.get('/api/chat/store/chat/private-chat', { idleTimeoutMs: 30000 });
  setActivePinia(createPinia());

  const board = useBoardStore();

  await board.load();
  assert.deepEqual(board.data.tasks, []);
  flushChatPerformance();

  const entries = f.log.snapshot().entries.filter((entry) => entry.ev === 'perf.operation');
  const operations = Object.fromEntries(entries.map((entry) => [entry.data.operation, entry.data.count]));

  assert.equal(operations['providers.parse'], 2);
  assert.equal(operations['chat.load.parse'], 1);
  assert.ok(operations['api.parse'] >= 1);
  assert.equal(operations['board.apply'], 1);
  assert.doesNotMatch(JSON.stringify(entries), /private-|token|api\/providers|tasks/u);
});

test('сводка объединяет частые вызовы, сохраняет максимум и только числовые размеры', () => {
  const f = fixture();
  const recorder = createChatPerformanceRecorder({
    ...f,
    view: () => '/projects/private-id?token=secret',
    afterFlush: (callback) => callback(),
  });

  for (let index = 0; index < 20; index += 1) {
    f.at(index * 100);

    const finish = recorder.start('markdown.lex', () => ({
      messages: 42,
      chars: 100,
      text: 'secret',
      chatId: 'private-id',
      operation: 'private-id',
    }));

    f.at(index * 100 + index + 1);
    finish();
  }

  assert.equal(f.log.status().count, 0);
  recorder.flush();

  const entry = f.log.snapshot().entries[0];

  assert.equal(entry.ev, 'perf.operation');
  assert.equal(entry.data.operation, 'markdown.lex');
  assert.equal(entry.data.count, 20);
  assert.equal(entry.data.totalMs, 210);
  assert.equal(entry.data.ms, 20);
  assert.equal(entry.data.periodMs, 1920);
  assert.equal(entry.data.view, '/projects/:id?');
  assert.equal(entry.data.messages, 42);
  assert.doesNotMatch(JSON.stringify(entry), /secret|private-id|chatId/u);
  recorder.flush();
  assert.equal(f.log.status().count, 1);
});

test('пять секунд ограничены восемью операциями и одной записью на вид блокировки', () => {
  const f = fixture();
  const recorder = createChatPerformanceRecorder({
    ...f,
    view: () => '/chats',
    afterFlush: (callback) => callback(),
  });

  for (const operation of ['sse.decode', 'sse.dispatch', 'chat.list', 'chat.materialize',
    'chat.snapshot', 'chat.fingerprint', 'chat.timeline', 'chat.steps.fold', 'markdown.lex']) {
    const finish = recorder.start(operation);

    f.at(f.now() + 80);
    finish();
  }
  for (let index = 0; index < 500; index += 1) {
    recorder.block('longtask', 0, 100);
  }

  recorder.flush();

  const entries = f.log.snapshot().entries;

  assert.equal(entries.filter((entry) => entry.ev === 'perf.operation').length, 8);
  assert.equal(entries.filter((entry) => entry.ev === 'perf.block').length, 1);
  assert.equal(entries.at(-1).data.count, 500);
  assert.equal(entries.at(-1).data.totalMs, 50_000);
});

test('обычная установка включает observers только при verbose и гасит старое поколение', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const f = fixture('errors');
  let visibility = 'visible';
  const doc = new EventTarget();

  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });

  class Observer {
    static supportedEntryTypes = ['longtask', 'long-animation-frame'];
    static instances = [];

    constructor(callback) {
      this.callback = callback;
      Observer.instances.push(this);
    }

    observe(options) {
      this.type = options.type;
    }

    disconnect() {
      this.disconnected = true;
    }

    emit(entries) {
      this.callback({ getEntries: () => entries });
    }
  }

  const stop = installChatPerformance({
    log: f.log,
    win: { performance: { now: f.now }, PerformanceObserver: Observer },
    doc,
    view: () => '/chats',
    afterFlush: (callback) => callback(),
  });

  t.after(stop);

  let metadataReads = 0;
  const counts = () => {
    metadataReads += 1;

    return { chars: 500 };
  };

  assert.equal(measureChatPerformance('markdown.lex', () => 'ok', counts), 'ok');
  assert.equal(metadataReads, 0);
  assert.equal(Observer.instances.length, 0);
  f.log.setLevel('verbose');
  assert.equal(Observer.instances.length, 2);
  assert.equal(f.log.snapshot().entries[0].ev, 'perf.ready');

  measureChatPerformance('markdown.lex', () => f.at(90), counts);
  Observer.instances[0].emit([{ startTime: 0, duration: 150 }]);
  Observer.instances[1].emit([{
    startTime: 0,
    duration: 160,
    renderStart: 60,
    scripts: [{
      duration: 100,
      forcedStyleAndLayoutDuration: 80,
      sourceURL: 'http://localhost:8140/assets/index-abcdef12.js?token=secret',
      sourceCharPosition: 42,
    }],
  }]);
  flushChatPerformance();

  const blocks = f.log.snapshot().entries.filter((entry) => entry.ev === 'perf.block');

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].data.operation, 'markdown.lex');
  assert.equal(blocks[1].data.layoutMs, 80);
  assert.equal(blocks[1].data.renderMs, 100);
  assert.equal(blocks[1].data.source, '/assets/index-abcdef12.js');
  assert.doesNotMatch(JSON.stringify(blocks), /token|secret|localhost/u);
  Observer.instances[1].emit([{
    startTime: 200,
    duration: 200,
    scripts: [{
      duration: 100,
      forcedStyleAndLayoutDuration: 0,
      sourceURL: '',
      sourceCharPosition: -1,
    }],
  }]);
  flushChatPerformance();
  assert.equal(f.log.snapshot().entries.at(-1).data.kind, 'animation-frame');
  assert.equal(f.log.snapshot().entries.at(-1).data.position, undefined);
  visibility = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  f.at(60_000);
  t.mock.timers.tick(60_000);
  assert.equal(Observer.instances[0].disconnected, true);
  visibility = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  f.log.setLevel('off');
  f.log.setLevel('verbose');
  Observer.instances[0].emit([{ startTime: 0, duration: 100_000 }]);
  flushChatPerformance();
  assert.equal(f.log.snapshot().entries.some((entry) => entry.ev === 'perf.block'), false);

  const failure = new Error('Рабочий отказ');

  assert.throws(() => measureChatPerformance('markdown.lex', () => {
    throw failure;
  }),
    (error) => error === failure);
  stop();
  assert.ok(Observer.instances.every((observer) => observer.disconnected));
});
