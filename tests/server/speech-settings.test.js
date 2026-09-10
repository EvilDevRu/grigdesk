import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import {
  SPEECH_DEFAULTS,
  SpeechSettingsStore,
} from '../../server/src/lib/speechSettings.ts';
import { SYSTEM } from '../../server/src/lib/pluginsRegistry.ts';
import settingsModule from '../../server/src/modules/settings/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function withPrefs(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-speech-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefsPath = path.join(dir, 'prefs.json');
  return { dir, prefsPath, prefs: new PrefsStore({ prefsPath }) };
}

async function settingsApp({ prefs, speechRuntime, events = [], modelJobs = undefined }) {
  const app = Fastify({ logger: false });
  app.decorate('sse', {
    broadcast: (event, data) => events.push({ event, data }),
  });
  await app.register(settingsModule, {
    credsStore: { publicView: () => ({}), write: () => {} },
    b24: { invalidate: () => {}, testAuth: async () => ({ ok: true }) },
    prefs,
    factoryDebug: {},
    speechRuntime,
    ...(modelJobs !== undefined ? { modelJobs } : {}),
  });
  return app;
}

test('PrefsStore.readStored не накладывает defaults, а read доклеивает speech глубоко', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);

  assert.deepEqual(prefs.readStored(), {});
  assert.deepEqual(prefs.read().speech, SPEECH_DEFAULTS);

  await writeFile(prefsPath, JSON.stringify({
    speech: { engine: 'whisper', dictionary: 'Fastify' },
  }));

  assert.deepEqual(prefs.readStored(), {
    speech: { engine: 'whisper', dictionary: 'Fastify' },
  });
  assert.deepEqual(prefs.read().speech, {
    ...SPEECH_DEFAULTS,
    engine: 'whisper',
    dictionary: 'Fastify',
  });
});

test('read остаётся fail-soft, но readStored показывает ошибку внутреннему коду', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);
  await writeFile(prefsPath, '{"speech":');

  assert.throws(() => prefs.readStored(), SyntaxError);
  assert.deepEqual(prefs.read().speech, SPEECH_DEFAULTS);
});

test('video plugin не объявляет второй источник speech-настроек', () => {
  const video = SYSTEM.find((plugin) => plugin.id === 'video');
  assert.ok(video);
  // Проверяется именно РЕЧЬ: качество, модель распознавания, язык и словарь живут в
  // едином speech-контракте, и вторая копия любого из этих ключей в plugin settings
  // означала бы два места правды. Настройки, которые к распознаванию отношения не
  // имеют (что делать с уже готовой расшифровкой), плагину принадлежать вправе.
  const speechKeys = new Set(Object.keys(SPEECH_DEFAULTS));
  const collisions = video.settings.map((setting) => setting.key).filter((key) => speechKeys.has(key));
  assert.deepEqual(collisions, []);
  // Ключей распознавания в speech-контракте достаточно, чтобы проверка была не
  // формальной: model, videoModel, quality, videoQuality, language, dictionary.
  assert.ok(speechKeys.has('videoModel') && speechKeys.has('videoQuality'));
});

test('SpeechSettingsStore сериализует частичные патчи и не теряет соседние поля', async (t) => {
  const { prefs } = await withPrefs(t);
  const speech = new SpeechSettingsStore({ prefs });

  await Promise.all([
    Promise.resolve().then(() => speech.update({ language: 'en' })),
    Promise.resolve().then(() => speech.update({ quality: 'accurate' })),
    Promise.resolve().then(() => speech.update({ resident: true })),
  ]);

  const current = speech.read();
  assert.equal(current.settings.language, 'en');
  assert.equal(current.settings.quality, 'accurate');
  assert.equal(current.settings.resident, true);
  assert.match(current.revision, /^speech:[0-9a-f-]{36}$/);

  const sameFile = new SpeechSettingsStore({ prefs }).read();
  assert.equal(sameFile.revision, current.revision, 'revision переживает новый экземпляр/рестарт');
});

test('speech API валидирует allowlist, диапазоны и защищает общий prefs-route', async (t) => {
  const { prefs } = await withPrefs(t);
  const app = await settingsApp({ prefs });
  t.after(() => app.close());

  const unknown = await app.inject({
    method: 'POST', url: '/api/settings/speech', payload: { surprise: true },
  });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error, 'bad_speech_setting');

  const outside = await app.inject({
    method: 'POST', url: '/api/settings/speech', payload: { keepAliveMin: 61 },
  });
  assert.equal(outside.statusCode, 400);
  assert.equal(outside.json().error, 'bad_speech_setting');

  const bypass = await app.inject({
    method: 'POST', url: '/api/settings/prefs', payload: { speech: { engine: 'whisper' } },
  });
  assert.equal(bypass.statusCode, 400);
  assert.equal(bypass.json().error, 'protected_preference');

  const neighbour = await app.inject({
    method: 'POST', url: '/api/settings/prefs', payload: { pluginSettings: {} },
  });
  assert.equal(neighbour.statusCode, 400);
  assert.equal(neighbour.json().error, 'protected_preference');

  const ordinary = await app.inject({
    method: 'POST', url: '/api/settings/prefs', payload: { showAllModels: true },
  });
  assert.equal(ordinary.statusCode, 200);
  assert.equal(ordinary.json().showAllModels, true);
});

test('GET/POST speech возвращают runtime capabilities и рассылают полный SSE-снимок', async (t) => {
  const { prefs } = await withPrefs(t);
  const events = [];
  const applied = [];
  const capabilities = {
    local: { ready: true, reason: null, checks: [] },
    models: [],
    cuda: { state: 'no_device' },
    languages: ['ru', 'en', 'auto'],
  };
  let invalidations = 0;
  const speechRuntime = {
    capabilities: async () => capabilities,
    applyRuntimeSettings: async (settings) => applied.push(settings),
    invalidateCapabilities: () => { invalidations += 1; },
  };
  const app = await settingsApp({ prefs, speechRuntime, events });
  t.after(() => app.close());

  const initial = await app.inject({ method: 'GET', url: '/api/settings/speech' });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json().capabilities, {
    ...capabilities,
    benchmark: {
      available: false,
      reason: 'Эталонная запись benchmark не настроена оператором.',
    },
  });
  const refreshed = await app.inject({
    method: 'GET', url: '/api/settings/speech?refresh=1',
  });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(invalidations, 1);

  const changed = await app.inject({
    method: 'POST',
    url: '/api/settings/speech',
    payload: { engine: 'whisper', dictionary: 'Cockpit\r\nFastify' },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().settings.engine, 'whisper');
  assert.equal(changed.json().settings.dictionary, 'Cockpit\nFastify');
  assert.equal(applied.length, 1);
  assert.deepEqual(events, [{ event: 'speech-settings', data: changed.json() }]);
});

test('GET speech refresh использует refreshCapabilities как legacy fallback', async (t) => {
  const { prefs } = await withPrefs(t);
  let refreshes = 0;
  let capabilityReads = 0;
  const app = await settingsApp({
    prefs,
    speechRuntime: {
      refreshCapabilities: async () => { refreshes += 1; },
      capabilities: async () => {
        capabilityReads += 1;
        return { local: { ready: false } };
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'GET', url: '/api/settings/speech?refresh=1',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(refreshes, 1);
  assert.equal(capabilityReads, 1);
});

test('GET speech подбирает завершённый detached model job до cached capabilities', async (t) => {
  const { prefs } = await withPrefs(t);
  let workerDone = false;
  let cached = false;
  let reconciled = false;
  const speechRuntime = {
    capabilities: async () => ({
      local: { ready: cached, reason: cached ? null : 'model missing', checks: [] },
      models: [{ modelId: 'medium', cached }],
    }),
    invalidateCapabilities: () => { cached = workerDone; },
  };
  const modelJobs = {
    benchmarkStatus: () => ({ available: false, reason: 'test' }),
    async reconcileCompleted() {
      if (!workerDone || reconciled) return 0;
      reconciled = true;
      speechRuntime.invalidateCapabilities();
      return 1;
    },
  };
  const app = await settingsApp({ prefs, speechRuntime, modelJobs });
  t.after(() => app.close());

  const before = await app.inject({ method: 'GET', url: '/api/settings/speech' });
  assert.equal(before.json().capabilities.models[0].cached, false);
  workerDone = true;
  const after = await app.inject({ method: 'GET', url: '/api/settings/speech' });
  assert.equal(after.json().capabilities.models[0].cached, true);
});

test('POST speech и browser consent не ждут тяжёлый CUDA capability probe', async (t) => {
  const { prefs } = await withPrefs(t);
  let capabilityReads = 0;
  let publicReads = 0;
  const app = await settingsApp({
    prefs,
    speechRuntime: {
      capabilities: async () => {
        capabilityReads += 1;
        return { local: { ready: true }, cuda: { state: 'ready' } };
      },
      applyRuntimeSettings: () => {},
      publicSnapshot: () => {
        publicReads += 1;
        return {
          local: { ready: true, reason: null, checks: [] },
          resident: { supported: false, loaded: false },
        };
      },
    },
  });
  t.after(() => app.close());

  const changed = await app.inject({
    method: 'POST', url: '/api/settings/speech', payload: { language: 'en' },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().capabilities.local.ready, true);
  assert.equal(capabilityReads, 0);

  const consent = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/browser-consent',
    payload: { confirm: true, revision: changed.json().revision },
  });
  assert.equal(consent.statusCode, 200);
  assert.equal(consent.json().settings.browserAutoConsent, true);
  assert.equal(capabilityReads, 0);
  assert.equal(publicReads, 2);

  await app.inject({ method: 'GET', url: '/api/settings/speech' });
  assert.equal(capabilityReads, 1, 'полный GET по-прежнему запускает диагностику CUDA');
});

test('HTTP-патчи сохраняют порядок через async runtime и SSE', async (t) => {
  const { prefs } = await withPrefs(t);
  const events = [];
  const calls = [];
  let enteredFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const speechRuntime = {
    capabilities: async () => ({}),
    applyRuntimeSettings: async (settings) => {
      calls.push(settings.language);
      if (calls.length === 1) {
        enteredFirst();
        await firstReleased;
      }
    },
  };
  const app = await settingsApp({ prefs, speechRuntime, events });
  t.after(() => app.close());

  const first = app.inject({
    method: 'POST', url: '/api/settings/speech', payload: { language: 'en' },
  });
  await firstEntered;
  const second = app.inject({
    method: 'POST', url: '/api/settings/speech', payload: { quality: 'accurate' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['en'], 'второй apply не обгоняет первый');
  releaseFirst();

  const [firstReply, secondReply] = await Promise.all([first, second]);
  assert.equal(firstReply.statusCode, 200);
  assert.equal(secondReply.statusCode, 200);
  assert.deepEqual(calls, ['en', 'en']);
  assert.equal(prefs.read().speech.language, 'en');
  assert.equal(prefs.read().speech.quality, 'accurate');
  assert.equal(events.length, 2);
  assert.equal(events[0].data.revision, firstReply.json().revision);
  assert.equal(events[1].data.revision, secondReply.json().revision);
});

test('browser consent требует актуальную revision и отзывается при выборе local', async (t) => {
  const { prefs } = await withPrefs(t);
  const events = [];
  const applied = [];
  const app = await settingsApp({
    prefs,
    events,
    speechRuntime: {
      capabilities: async () => ({}),
      applyRuntimeSettings: async (settings) => applied.push(settings),
    },
  });
  t.after(() => app.close());

  const first = await app.inject({ method: 'GET', url: '/api/settings/speech' });
  const revision = first.json().revision;

  const stale = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/browser-consent',
    payload: { confirm: true, revision: 'sha256:stale' },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'stale_speech_settings');
  assert.equal(prefs.read().speech.browserAutoConsent, false);

  const consent = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/browser-consent',
    payload: { confirm: true, revision },
  });
  assert.equal(consent.statusCode, 200);
  assert.equal(consent.json().settings.browserAutoConsent, true);
  assert.notEqual(consent.json().revision, revision);
  assert.equal(applied.at(-1).browserAutoConsent, true);

  const validated = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/browser-consent',
    payload: { confirm: true, revision: consent.json().revision },
  });
  assert.equal(validated.statusCode, 200);
  assert.equal(validated.json().revision, consent.json().revision,
    'повторная validation не создаёт новую revision');

  const local = await app.inject({
    method: 'POST',
    url: '/api/settings/speech',
    payload: { browserProcessing: 'local' },
  });
  assert.equal(local.statusCode, 200);
  assert.equal(local.json().settings.browserAutoConsent, false);

  const auto = await app.inject({
    method: 'POST',
    url: '/api/settings/speech',
    payload: { browserProcessing: 'auto' },
  });
  assert.notEqual(auto.json().revision, revision, 'ABA не оживляет старое подтверждение');

  const abaStale = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/browser-consent',
    payload: { confirm: true, revision },
  });
  assert.equal(abaStale.statusCode, 409);

  const directGrant = await app.inject({
    method: 'POST',
    url: '/api/settings/speech',
    payload: { browserAutoConsent: true },
  });
  assert.equal(directGrant.statusCode, 400);

  const whisper = await app.inject({
    method: 'POST',
    url: '/api/settings/speech',
    payload: { engine: 'whisper' },
  });
  const wrongModeConsent = await app.inject({
    method: 'POST',
    url: '/api/settings/speech/browser-consent',
    payload: { confirm: true, revision: whisper.json().revision },
  });
  assert.equal(wrongModeConsent.statusCode, 409);
  assert.equal(prefs.read().speech.browserAutoConsent, false);

  assert.equal(events.length, 4, 'idempotent validation не создаёт лишнее SSE-событие');
});

test('PrefsStore сохраняет speech атомарно поверх уже существующих prefs', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);
  prefs.write({ showAllModels: true });
  const speech = new SpeechSettingsStore({ prefs });
  const changed = speech.update({ language: 'auto' });
  prefs.write({ accessGateway: true });

  const stored = JSON.parse(await readFile(prefsPath, 'utf8'));
  assert.equal(stored.showAllModels, true);
  assert.equal(stored.accessGateway, true);
  assert.equal(stored.speech.language, 'auto');
  assert.equal('schemaVersion' in stored.speech, false);
  assert.equal(stored.speech._revision, changed.revision);
});
