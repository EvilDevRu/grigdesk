// Рубеж вокруг общих настроек: реестры проектов меняются только своим API.
//
// `POST /api/settings/prefs` — ручка «сохранить всё, что прислали». Пока `projects` и
// `projectsMeta` не были закрыты, одна такая запись из чужого места стирала паспорта
// проектов целиком: файл настроек один, и затирание выглядело как успешное сохранение.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import settingsModule from '../../server/src/modules/settings/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function withPrefs(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-projects-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefsPath = path.join(dir, 'prefs.json');
  return { dir, prefsPath, prefs: new PrefsStore({ prefsPath }) };
}

async function settingsApp({ prefs, events = [] }) {
  const app = Fastify({ logger: false });

  app.decorate('sse', {
    broadcast: (event, data) => events.push({ event, data }),
  });
  await app.register(settingsModule, {
    credsStore: { publicView: () => ({}), write: () => {} },
    b24: { invalidate: () => {}, testAuth: async () => ({ ok: true }) },
    prefs,
    factoryDebug: {},
    speechRuntime: undefined,
    modelJobs: null,
  });

  return app;
}

test('POST /api/settings/prefs не трогает реестры проектов', async (t) => {
  const { prefs } = await withPrefs(t);
  const app = await settingsApp({ prefs });

  t.after(() => app.close());

  for (const key of ['projects', 'projectsMeta']) {
    const reply = await app.inject({
      method: 'POST',
      url: '/api/settings/prefs',
      payload: { [key]: {} },
    });

    assert.equal(reply.statusCode, 400, `${key} обязан быть защищён`);
    assert.equal(reply.json().error, 'protected_preference');
    assert.match(reply.json().message, /\/api\/projects/);
  }

  const ok = await app.inject({
    method: 'POST',
    url: '/api/settings/prefs',
    payload: { showAllModels: true },
  });

  assert.equal(ok.statusCode, 200);
  assert.equal(prefs.readStored().showAllModels, true);
});

test('POST /api/settings/prefs на битом файле отвечает prefs_corrupted и файл не меняет', async (t) => {
  const { prefs, prefsPath } = await withPrefs(t);
  const broken = '{"speech":';

  await writeFile(prefsPath, broken, 'utf8');
  const app = await settingsApp({ prefs });

  t.after(() => app.close());

  const reply = await app.inject({
    method: 'POST',
    url: '/api/settings/prefs',
    payload: { showAllModels: true },
  });

  assert.equal(reply.statusCode, 500);
  assert.equal(reply.json().error, 'prefs_corrupted');
  assert.equal(await readFile(prefsPath, 'utf8'), broken);
});

test('общий prefs API скрывает nativeSettings в GET и успешном POST', async (t) => {
  const { prefs } = await withPrefs(t);
  prefs.write({
    providerSettings: {
      future: { blockDirectSsh: true, nativeSettings: { sentinel: 'private-native-value' } },
      neighbor: { fastMode: false },
    },
  });
  const app = await settingsApp({ prefs });
  t.after(() => app.close());
  const read = await app.inject('/api/settings/prefs');
  const saved = await app.inject({
    method: 'POST',
    url: '/api/settings/prefs',
    payload: { showAllModels: true },
  });

  for (const response of [read, saved]) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes('private-native-value'), false);
    assert.deepEqual(response.json().providerSettings, {
      future: { blockDirectSsh: true },
      neighbor: { fastMode: false },
    });
  }

  assert.equal(prefs.read().providerSettings.future.nativeSettings.sentinel, 'private-native-value');
});
