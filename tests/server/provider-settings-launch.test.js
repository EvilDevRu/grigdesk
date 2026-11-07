import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import { syntheticProvider } from '../fixtures/executor-settings/syntheticProvider.js';
import { chatAppFixture, saveChat, turnBody, waitFor } from './helpers/chat-turns.js';
import { prepareChatNativeSettings } from '../../server/src/lib/executorSettings/launch.ts';

const execFileAsync = promisify(execFile);

/**
 * Выбор существует только в оперативной памяти теста; каждый снимок имеет свою ревизию.
 * Пустой набор означает reset, без удаления самого счётчика ревизий.
 */
function savedChoice(providerId, revision, value) {
  return {
    [providerId]: {
      nativeSettings: {
        format: 1,
        revision,
        overrides: value === undefined ? {} : { '["enabled"]': { path: ['enabled'], value } },
      },
    },
  };
}

test('новый boolean проходит API и storage до фактического входа fake CLI чата', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-launch-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inputPath = path.join(root, 'cli-input.json');
  const cliPath = path.join(root, 'fake-cli.mjs');

  fs.writeFileSync(
    cliPath,
    `
    import fs from 'node:fs';
    fs.writeFileSync(process.argv[2], process.argv[3]);
  `,
  );

  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const provider = syntheticProvider();

  provider.run = async (options) => {
    await execFileAsync(process.execPath, [
      cliPath,
      inputPath,
      JSON.stringify({
        payload: options.nativeSettings?.payload ?? {},
        local: options.providerSettings,
      }),
    ]);

    return { reply: 'готово', sessionId: 'fake-session' };
  };

  const { app } = await chatAppFixture(t, {
    root,
    executor: provider,
    prefs: {
      chatLiveSessions: false,
      get providerSettings() {
        return prefs.read().providerSettings;
      },
    },
    async extraRoutes(server) {
      await server.register(providersModule, {
        config: { rootDir: root, modelsPath: path.join(root, 'models.json') },
        prefs,
        getProviderAdapters: async () => new Map([[provider.id, provider]]),
      });
    },
  });
  const catalog = (await app.inject('/api/providers/future-provider/settings/catalog')).json();
  const saved = await app.inject({
    method: 'POST',
    url: '/api/providers/future-provider/settings/overrides',
    payload: {
      fieldId: catalog.fields[0].id,
      operation: 'set',
      value: false,
      revision: '0',
      schemaRevision: catalog.schemaRevision,
    },
  });

  assert.equal(saved.statusCode, 200);
  await saveChat(app, 'native-chat');

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('native-chat', 'native-turn-0001'),
  });

  assert.equal(accepted.statusCode, 202);
  await waitFor(() => fs.existsSync(inputPath), { what: 'вход fake CLI' });

  const received = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  assert.equal(received.payload.enabled, false);
  assert.equal(Object.hasOwn(received.local, 'nativeSettings'), false);
});

test('активный базовый override отказывает несовместимому cwd и работает во второй папке', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cwd-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bad = path.join(root, 'incompatible');
  const good = path.join(root, 'compatible');

  fs.mkdirSync(bad);
  fs.mkdirSync(good);

  const adapter = syntheticProvider();
  const original = adapter.nativeSettings.discover;

  adapter.nativeSettings.discover = async (context, options) => {
    const snapshot = await original(context, options);

    if (context.cwdRealpath === bad) {
      snapshot.ownership.push({
        path: ['enabled'],
        owner: 'Проектная политика',
        reason: 'Запрещено этой папкой',
      });
    }

    return snapshot;
  };

  const settings = {
    'future-provider': {
      nativeSettings: {
        format: 1,
        revision: 1,
        overrides: {
          '["enabled"]': { path: ['enabled'], value: false },
        },
      },
    },
  };

  await assert.rejects(prepareChatNativeSettings(adapter, { rootDir: root }, bad, settings), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'native_settings_incompatible');
    assert.deepEqual(error.fieldIds, ['["enabled"]']);

    return true;
  });

  const valid = await prepareChatNativeSettings(adapter, { rootDir: root }, good, settings);

  assert.equal(valid.payload.enabled, false);
  assert.equal(settings['future-provider'].nativeSettings.revision, 1);
});

test('без overrides нет discovery, а недоступный источник с активным выбором запрещает запуск', async () => {
  const provider = syntheticProvider();

  provider.nativeSettings.discover = async () => {
    throw new Error('private-error-sentinel');
  };

  assert.equal(
    await prepareChatNativeSettings(provider, { rootDir: os.tmpdir() }, os.tmpdir(), {}),
    undefined,
  );
  await assert.rejects(
    prepareChatNativeSettings(
      provider,
      { rootDir: os.tmpdir() },
      os.tmpdir(),
      savedChoice(provider.id, 1, false),
    ),
    (error) =>
      error.code === 'settings_unavailable' &&
      error.statusCode === 503 &&
      !error.message.includes('sentinel'),
  );
});

test('изменение prefs во время подготовки не меняет выбранный неизменяемый снимок', async () => {
  const provider = syntheticProvider();
  const original = provider.nativeSettings.prepare;
  let release;
  let reached;
  const preparing = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  provider.nativeSettings.prepare = async (...args) => {
    reached();
    await gate;

    return original(...args);
  };

  const saved = savedChoice(provider.id, 1, false);
  const pending = prepareChatNativeSettings(provider, { rootDir: os.tmpdir() }, os.tmpdir(), saved);

  await preparing;
  saved[provider.id].nativeSettings.overrides['["enabled"]'].value = true;
  release();

  const plan = await pending;

  assert.equal(plan.payload.enabled, false);
  assert.equal(plan.accepted[0].value, false);
  assert.equal(Object.isFrozen(plan.payload), true);
  assert.throws(() => {
    plan.payload.enabled = true;
  }, TypeError);
});

test('очередь, in-turn, refresh и reset сохраняют границы снимка живой сессии', async (t) => {
  const provider = syntheticProvider();

  provider.id = 'test-provider';
  provider.inTurnInput = {
    protocol: 1,
    text: true,
    confirmation: 'forwarded',
  };

  const opened = [];
  const sends = [];
  const delivered = [];
  let selected = savedChoice(provider.id, 1, false);

  t.after(() => {
    for (const sent of sends) {
      sent.release();
    }
  });

  provider.session = {
    mode: 'persistent',
    restartOn: ['nativeSettingsFingerprint'],
    async open(spec) {
      const handle = {
        spec,
        alive: true,
        closed: false,
        interrupted: 0,
        /**
         * Завершение удерживается тестом: новый выбор приходит в prefs,
         * пока текущая сессия ещё занята и её порт уточнений открыт.
         */
        async send(turn) {
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });

          sends.push({ spec, release });
          turn.onInTurnReady?.({
            async deliver(input) {
              delivered.push(input);

              return { ok: true, state: 'forwarded' };
            },
            close() {},
          });
          await gate;

          return {
            reply: 'готово',
            sessionId: 'native-persistent-session',
            steps: [],
          };
        },
        async interrupt() {
          handle.interrupted += 1;
        },
        async close() {
          handle.closed = true;
          handle.alive = false;
        },
      };

      opened.push(handle);

      return handle;
    },
  };

  const { app } = await chatAppFixture(t, {
    executor: provider,
    prefs: {
      chatLiveSessions: true,
      get providerSettings() {
        return selected;
      },
    },
  });

  await saveChat(app, 'native-live');

  const start = (suffix) =>
    app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody('native-live', `native-live-${suffix}`),
    });

  assert.equal((await start('0001')).statusCode, 202);
  await waitFor(() => sends.length === 1);

  const firstDiscoveries = provider.discoveries();
  const active = await waitFor(async () => {
    const state = (await app.inject('/api/chat/active'))
      .json()
      .active.find((entry) => entry.chatKey === 'native-live');

    return state?.inTurn?.available ? state : null;
  });

  selected = savedChoice(provider.id, 2, true);

  const queued = await start('0002');

  assert.equal(queued.json().state, 'queued');
  assert.equal(provider.discoveries(), firstDiscoveries);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].closed, false);
  assert.equal(opened[0].interrupted, 0);
  assert.equal(sends[0].spec.nativeSettings.payload.enabled, false);

  const steered = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'native-live',
      targetRunId: active.runId,
      messageId: 'native-steer-0001',
      text: 'Уточнение',
    },
  });

  assert.equal(steered.statusCode, 202);
  await waitFor(() => delivered.length === 1);
  assert.equal(provider.discoveries(), firstDiscoveries);

  sends[0].release();
  await waitFor(() => sends.length === 2);
  assert.equal(opened.length, 2);
  assert.equal(opened[0].closed, true);
  assert.equal(opened[1].spec.sessionId, 'native-persistent-session');
  assert.equal(sends[1].spec.nativeSettings.payload.enabled, true);

  selected = savedChoice(provider.id, 3, true);
  assert.equal((await start('0003')).json().state, 'queued');
  sends[1].release();
  await waitFor(() => sends.length === 3);
  assert.equal(opened.length, 2, 'Равные accepted при новой ревизии не открывают процесс заново');

  selected = savedChoice(provider.id, 4, undefined);
  assert.equal((await start('0004')).json().state, 'queued');
  assert.equal(opened[1].closed, false);
  assert.equal(opened[1].interrupted, 0);
  sends[2].release();
  await waitFor(() => sends.length === 4);
  assert.equal(opened.length, 3);
  assert.equal(sends[3].spec.nativeSettings, undefined);
  assert.equal(sends[3].spec.nativeSettingsFingerprint, '');
  assert.equal(opened[2].spec.sessionId, 'native-persistent-session');
  sends[3].release();
});
