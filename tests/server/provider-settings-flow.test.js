import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import schemaV1 from '../fixtures/executor-settings/synthetic-v1.json' with { type: 'json' };
import schemaV2 from '../fixtures/executor-settings/synthetic-v2.json' with { type: 'json' };
import schemaV3 from '../fixtures/executor-settings/synthetic-v3.json' with { type: 'json' };
import schemaV4 from '../fixtures/executor-settings/synthetic-v4.json' with { type: 'json' };
import { syntheticProvider } from '../fixtures/executor-settings/syntheticProvider.js';
import { chatAppFixture, saveChat, turnBody, waitFor } from './helpers/chat-turns.js';
import providersModule from '../../server/src/modules/providers/index.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';

const execFileAsync = promisify(execFile);

test('публичный flow v1 → v2 → сбой → v3 → v4 доводит новые поля до CLI и сохраняет reset', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-flow-'));

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inputPath = path.join(root, 'cli-input.jsonl');
  const cliPath = path.join(root, 'fake-cli.mjs');
  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  let current = schemaV1;
  const provider = syntheticProvider({
    readSchema: () => {
      if (current === null) {
        throw new Error('private-sentinel');
      }

      return current;
    },
  });

  fs.writeFileSync(
    cliPath,
    `
    import fs from 'node:fs';
    fs.appendFileSync(process.argv[2], process.argv[3] + '\\n');
  `,
  );
  prefs.write({
    providerSettings: {
      'future-provider': { blockDirectSsh: true },
      neighbor: { blockDirectSsh: false },
    },
  });

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

  /**
   * Каталог читается через публичный маршрут, включая принудительное обновление.
   * В каждой версии проверяется отсутствие приватного текста ошибки источника.
   */
  const read = async () => {
    const response = await app.inject('/api/providers/future-provider/settings/catalog?refresh=1');

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes('private-sentinel'), false);

    return response.json();
  };
  const write = async (catalog, fieldId, operation, value) =>
    app.inject({
      method: 'POST',
      url: '/api/providers/future-provider/settings/overrides',
      payload: {
        fieldId,
        operation,
        schemaRevision: catalog.schemaRevision,
        revision: catalog.revision,
        ...(operation === 'set' ? { value } : {}),
      },
    });
  let runs = 0;
  /**
   * Отдельный чат доводит снимок до входа настоящего дочернего fake CLI.
   * Проверяется его файл, а не вызов промежуточного helper подготовки.
   */
  const run = async () => {
    runs += 1;

    const chatKey = `flow-chat-${runs}`;

    await saveChat(app, chatKey);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: turnBody(chatKey, `flow-turn-${String(runs).padStart(6, '0')}`),
    });

    assert.equal(accepted.statusCode, 202);

    await waitFor(
      () => fs.existsSync(inputPath) && fs.readFileSync(inputPath, 'utf8').trim().split('\n').length === runs,
    );

    const received = JSON.parse(fs.readFileSync(inputPath, 'utf8').trim().split('\n').at(-1));

    assert.equal(Object.hasOwn(received.local, 'nativeSettings'), false);

    return received.payload;
  };
  const first = await read();
  const savedA = await write(first, '["enabled"]', 'set', false);

  assert.equal(savedA.statusCode, 200);
  assert.deepEqual(await run(), { enabled: false });

  current = schemaV2;

  const second = await read();
  const savedB = await write(second, '["futureFlag"]', 'set', true);

  assert.equal(savedB.statusCode, 200);
  assert.deepEqual(await run(), { enabled: false, futureFlag: true });

  current = null;

  const stale = await read();
  const blocked = await write(stale, '["futureFlag"]', 'set', false);

  assert.equal(stale.state, 'stale');
  assert.equal(blocked.statusCode, 503);
  assert.equal(prefs.read().providerSettings['future-provider'].nativeSettings.revision, 2);
  assert.equal(stale.inactiveOverrides.length, 0);

  current = schemaV3;

  const third = await read();

  assert.equal(third.inactiveOverrides[0].id, '["enabled"]');
  assert.equal(Object.hasOwn(third.inactiveOverrides[0], 'value'), false);
  assert.deepEqual(await run(), { futureFlag: true });

  current = schemaV4;

  const fourth = await read();
  const invalid = await write(fourth, '["futureFlag"]', 'set', true);
  const outdated = await write(savedB.json().catalog, '["futureFlag"]', 'set', false);

  assert.equal(fourth.inactiveOverrides.length, 2);
  assert.equal(invalid.statusCode, 422);
  assert.equal(outdated.statusCode, 409);
  assert.deepEqual(await run(), {});

  const unsetA = await write(fourth, '["enabled"]', 'unset');

  assert.equal(unsetA.statusCode, 200);

  const unsetB = await write(unsetA.json().catalog, '["futureFlag"]', 'unset');

  assert.equal(unsetB.statusCode, 200);
  assert.equal(unsetB.json().catalog.revision, '4');
  assert.deepEqual(prefs.read().providerSettings.neighbor, { blockDirectSsh: false });
  assert.equal(prefs.read().providerSettings['future-provider'].blockDirectSsh, true);
  assert.deepEqual(prefs.read().providerSettings['future-provider'].nativeSettings.overrides, {});
});
