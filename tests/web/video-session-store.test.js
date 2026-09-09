// Сеанс разбора встречи: что переживает уход со страницы, а что — перезагрузку.
//
// Обещания:
//  - id распознавания и набранные черновики живут дольше самой страницы: разбор идёт
//    на сервере, и терять к нему ключ из-за перехода в соседний раздел нельзя;
//  - расшифровка в снимок НЕ попадает — она уже лежит на сервере и перечитывается
//    по jobId, а её копия в браузере копила бы мегабайты;
//  - пропавший на сервере разбор назван словами, а не изображает вечную загрузку.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

import { compileModule, webFile } from './helpers/compile-vue.js';

const STORAGE_KEY = 'cockpit-video-session';

const module = await compileModule(webFile('src/stores/videoSession.ts'), {
  stubs: {
    // Ленивый прокси, а не значение: стаб выполняется на импорте модуля, то есть до
    // того, как тест подставит свой api, и снимок `globalThis` остался бы пустым.
    '../shared/api-client.js': `export const api = {
      get: (...args) => globalThis.__videoSessionApi.get(...args),
      post: (...args) => globalThis.__videoSessionApi.post(...args),
    };`,
    // Транспорт раздела ходит в общий клиент своим путём — заглушка сопоставляется
    // по точной строке импорта, поэтому у shared/mediaApi.ts она отдельная.
    './api-client.js': `export const api = {
      url: (path) => path,
      get: (...args) => globalThis.__videoSessionApi.get(...args),
      post: (...args) => globalThis.__videoSessionApi.post(...args),
    };`,
    './plugins.js': 'export const usePluginsStore = () => globalThis.__videoSessionPlugins();',
  },
});

/** Хранилище браузера в памяти: раздел обязан работать и там, где его нет вовсе. */
function installStorage(t, initial = null) {
  const data = new Map();

  if (initial !== null) {
    data.set(STORAGE_KEY, initial);
  }

  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
  t.after(() => { globalThis.localStorage = previous; });

  return data;
}

function newSession(t, { get = async () => ({}), post = async () => ({}) } = {}) {
  setActivePinia(createPinia());
  globalThis.__videoSessionApi = { get, post };
  globalThis.__videoSessionPlugins = () => ({ byId: () => null });
  t.after(() => {
    delete globalThis.__videoSessionApi;
    delete globalThis.__videoSessionPlugins;
  });

  return module.useVideoSessionStore();
}

test('сеанс переживает перезагрузку страницы, а расшифровка в снимок не попадает', async (t) => {
  const storage = installStorage(t);
  const first = newSession(t);
  first.hydrate();

  first.parts = [{
    name: 'встреча.mp4',
    size: 1024,
    jobId: 'job-1',
    // Расшифровка приезжает с сервера и в снимке не нужна: 17 минут разговора — это
    // сотни килобайт текста, а ключ к ним — один jobId.
    job: {
      status: 'done',
      progress: null,
      error: null,
      result: { duration: 90, transcript: { segments: [{ start: 0, end: 1, text: 'привет' }] } },
    },
    gone: false,
  }];
  first.uploaded = { name: 'встреча.mp4', size: 1024 };
  first.drafts = [{ ...first.emptyDraft(), title: 'Своя задача', description: 'текст' }];
  first.persistNow();

  const snapshot = JSON.parse(storage.get(STORAGE_KEY));
  assert.equal(snapshot.parts[0].jobId, 'job-1');
  assert.equal('job' in snapshot.parts[0], false, 'статус и расшифровка в снимок не идут');
  assert.equal(snapshot.drafts[0].title, 'Своя задача');
  assert.equal('creating' in snapshot.drafts[0], false, 'runtime-флаги не восстанавливают работу');

  const second = newSession(t);
  second.hydrate();
  assert.equal(second.parts.length, 1);
  assert.equal(second.parts[0].jobId, 'job-1');
  assert.equal(second.parts[0].job, null, 'статус дочитывается с сервера, а не из браузера');
  assert.equal(second.drafts[0].title, 'Своя задача');
  assert.equal(second.drafts[0].creating, false);
  assert.equal(second.uploaded.name, 'встреча.mp4');
});

test('повреждённый снимок не становится черновиком с битым вложением', async (t) => {
  installStorage(t, JSON.stringify({
    v: 1,
    savedAt: Date.now(),
    parts: [{ name: 'встреча.mp4', size: 1024, jobId: 'job-1' }],
    uploaded: { name: 42, size: 'много' },
    created: ['t-1', 7, { chuzhoe: true }],
    defPriority: 'высокий',
    drafts: [{
      title: { скрипт: '<img onerror>' },
      priority: 'срочно',
      // Кадр уезжает на портал по имени, а секунда его потеряна: вложения нет.
      frame: { name: 'frame-000010s.jpg' },
      clip: { name: 'clip.mp4', at: 10, from: 0, to: 20 },
      at: 'десятая',
      creating: true,
      clipBusy: true,
      error: 'прошлая ошибка',
    }],
  }));
  const session = newSession(t);
  session.hydrate();

  const draft = session.drafts[0];

  assert.deepEqual({
    title: draft.title,
    priority: draft.priority,
    frame: draft.frame,
    clip: draft.clip,
    at: draft.at,
    creating: draft.creating,
    clipBusy: draft.clipBusy,
    error: draft.error,
    uploaded: session.uploaded,
    created: session.created,
    defPriority: session.defPriority,
  }, {
    title: '',
    priority: 1,
    frame: null,
    clip: null,
    at: null,
    creating: false,
    clipBusy: false,
    error: null,
    uploaded: null,
    created: ['t-1', 7],
    defPriority: 1,
  });
});

test('снимок старше недели не поднимается: кадров и фрагментов к нему уже нет', async (t) => {
  const stale = JSON.stringify({
    v: 1,
    savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    parts: [{ name: 'старая.mp4', size: 10, jobId: 'job-old' }],
    drafts: [{ title: 'Забытая задача' }],
  });
  const storage = installStorage(t, stale);
  const session = newSession(t);
  session.hydrate();

  assert.equal(session.parts.length, 0);
  assert.equal(session.drafts.length, 0);
  assert.equal(storage.has(STORAGE_KEY), false, 'протухший снимок удаляется, а не лежит вечно');
});

test('возврат в раздел дочитывает статусы частей и продолжает поллинг', async (t) => {
  installStorage(t, JSON.stringify({
    v: 1,
    savedAt: Date.now(),
    parts: [{ name: 'встреча.mp4', size: 10, jobId: 'job-1' }],
    drafts: [],
  }));

  const asked = [];
  const session = newSession(t, {
    get: async (url) => {
      asked.push(url);
      return { status: 'running', progress: { done: 1, total: 4 }, result: null, error: null };
    },
  });
  session.hydrate();
  await session.resume();

  assert.deepEqual(asked, ['/api/media/ingest/job-1']);
  assert.equal(session.job.status, 'running', 'прогресс виден сразу, без ожидания тика');
  assert.equal(session.polling, true, 'незаконченный разбор продолжает опрашиваться');
  session.stopPoll();
});

test('пропавший на сервере разбор назван словами, а не вечной загрузкой', async (t) => {
  installStorage(t, JSON.stringify({
    v: 1,
    savedAt: Date.now(),
    parts: [{ name: 'встреча.mp4', size: 10, jobId: 'job-gone' }],
    drafts: [{ title: 'Своя задача' }],
  }));

  const session = newSession(t, {
    get: async () => {
      const error = new Error('HTTP 404');
      error.status = 404;
      error.data = { error: 'not_found' };
      throw error;
    },
  });
  session.hydrate();
  await session.resume();

  assert.equal(session.parts[0].gone, true);
  assert.match(session.error, /загрузить заново/u);
  assert.equal(session.polling, false, 'ждать возвращения пропавшего job бессмысленно');
  // Черновики человека при этом целы: их ещё можно поставить в B24.
  assert.equal(session.drafts[0].title, 'Своя задача');
});

test('«убрать разбор» стирает и экран, и снимок', async (t) => {
  const storage = installStorage(t);
  const session = newSession(t);
  session.hydrate();

  session.parts = [{ name: 'встреча.mp4', size: 10, jobId: 'job-1', job: null, gone: false }];
  session.drafts = [{ ...session.emptyDraft(), title: 'Своя задача' }];
  session.persistNow();
  assert.equal(storage.has(STORAGE_KEY), true);

  session.reset();
  assert.equal(session.parts.length, 0);
  assert.equal(session.drafts.length, 0);
  assert.equal(storage.has(STORAGE_KEY), false);
});

test('сервер молчит — поллинг гаснет и объясняет себя, а не долбит закрытый API', async (t) => {
  installStorage(t);
  const session = newSession(t, {
    get: async () => { throw new Error('Failed to fetch'); },
  });
  session.hydrate();
  session.parts = [{ name: 'встреча.mp4', size: 10, jobId: 'job-1', job: null, gone: false }];
  session.startPoll();

  for (let i = 0; i < 5; i += 1) {
    await session.tick();
  }

  assert.equal(session.polling, false);
  assert.match(session.error, /не отвечает/u);
});
