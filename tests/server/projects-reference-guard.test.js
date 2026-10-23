import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createSshStore } from '../../server/src/lib/ssh/store.ts';
import { createDbStore } from '../../server/src/lib/db/store.ts';
import { listProjects } from '../../server/src/lib/profiles.ts';
import { isProjectDeleted } from '../../server/src/lib/projects/deletion.ts';
import { PrefsCorruptedError } from '../../server/src/lib/prefsStore.ts';
import telegramModule from '../../server/src/modules/telegram/index.ts';
import githubModule from '../../server/src/modules/github/index.ts';
import { Fastify } from './helpers/chat-turns.js';
import { pdFixture, pdDeferred } from './helpers/projects-deletion.js';

for (const [owner, createStore] of [['ssh', createSshStore], ['db', createDbStore]]) {
  test(`PD-reference: запись связи сериализована с мутацией регистрации (${owner})`, async (t) => {
    const f = await pdFixture(t);
    const entered = pdDeferred();
    const release = pdDeferred();
    const order = [];
    let guardCalls = 0;
    let pause = true;

    assert.equal(typeof f.service.withReferences, 'function', 'общая очередь ссылок отсутствует');

    const store = await createStore({
      file: path.join(f.root, `${owner}.json`),
      projects: async () => {
        if (pause) {
          pause = false;
          entered.resolve();
          await release.promise;
        }

        return [{ id: 'demo' }];
      },
      withReferences: (op) => f.service.withReferences(async () => {
        guardCalls += 1;

        const result = await op();

        order.push('reference');

        return result;
      }),
    });
    const input = {

      projectId: 'demo',
      label: 'Тест',
      role: owner === 'ssh' ? 'code' : 'read',

      engine: 'mysql',
      host: 'fixture.invalid',
      user: 'fixture',
      database: 'test',

    };
    const writing = store.create(input);

    await entered.promise;

    const updating = f.service.update('demo', {

      title: 'Правка',
      description: '',
      tags: [],
      repos: f.repos,
      defaultRepoKey: 'main',

    }, 1).then(() => {
      order.push('update');
    });

    release.resolve();

    const created = await writing;

    await updating;
    assert.deepEqual(order, ['reference', 'update']);
    await store.update(created.id, { label: 'Правка подключения' });
    assert.equal(guardCalls, 2, 'create и update используют один guard');
  });
}

for (const channel of ['telegram', 'github']) {
  test(`PD-rule-save: tombstone отвергается даже при пустом каталоге (${channel})`, async (t) => {
    const app = Fastify({ logger: false });
    const raw = [{
      project: 'demo',
      chatId: -10042,
      repositoryId: '123456',
      kind: 'bug'
    }];
    let writes = 0;
    const rules = {
      read: async () => structuredClone(raw),

      write: async () => {
        writes += 1;

        return raw;
      },

      writeHumanCas: async () => {
        writes += 1;

        return { rules: raw, policyFingerprint: 'unchanged' };
      },
    };
    const lease = {
      context: {
        botId: '8123456789',
        repositoryId: '123456',
        rules
      },
      isCurrent: () => true,
      release() { },
    };
    const connection = {
      status: async () => ({

        configured: true,
        connection: 'connected',
        repositoryId: '123456',
        bot: { botId: '8123456789' },

      }),
      connect: async () => ({}),
      disconnect: async () => ({}),
      recheck: async () => ({}),
      handleWebhook: async () => ({}),
      acquireLease: () => lease,
      acquireInboxLease: () => lease,
    };

    app.decorate('pluginEnabled', () => true);
    app.decorate('sse', { broadcast() { } });
    await app.register(channel === 'telegram' ? telegramModule : githubModule, {
      connection,
      listProjects: async () => [],
      isProjectDeleted: (id) => id === 'demo',
      withReferences: (op) => op(),
    });
    t.after(() => app.close());

    const payload = channel === 'telegram'
      ? {
        botId: '8123456789',
        policyFingerprint: 'unchanged',
        rules: raw
      }
      : { repositoryId: '123456', rules: raw };
    const response = await app.inject({
      method: 'PUT',
      url: `/api/${channel}/rules`,
      payload
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'tombstoned');
    assert.equal(response.json().message, 'Регистрация проекта «demo» удалена.');
    assert.equal(writes, 0);
    assert.deepEqual(await rules.read(), raw);
  });
}

test('PD-wiring: app передаёт защиту владельцам', async () => {
  const app = await readFile(new URL('../../server/src/app.ts', import.meta.url), 'utf8');
  const chat = await readFile(new URL('../../server/src/modules/chat/index.ts', import.meta.url), 'utf8');

  assert.equal(app.split('withReferences: projectsService.withReferences,').length - 1, 4);
  assert.equal(app.split('isProjectDeleted: isDeletedProject,').length - 1, 6);
  assert.match(app, /register\(chatModule,\s*\{[\s\S]*?\bprojectsService,/u);
  assert.match(chat, /registerDeletionCleanup\(/u);
});

for (const [owner, createStore] of [['ssh', createSshStore], ['db', createDbStore]]) {
  test(`PD: нечитаемые prefs запрещают create/update связи (${owner})`, async (t) => {
    const f = await pdFixture(t);
    const file = path.join(f.root, `${owner}.json`);
    const store = await createStore({
      file,
      projects: async () => (await listProjects(f.config, f.prefs)).map((id) => ({ id })),
      isProjectDeleted: (id) => isProjectDeleted(f.prefs, id),
      withReferences: f.service.withReferences,
    });
    const input = {
      projectId: 'other',
      label: 'Связь',
      role: 'read',
      engine: 'mysql',
      host: 'fixture.invalid',
      user: 'fixture',
      database: 'test',
    };
    const existing = await store.create(input);

    await f.service.archive('demo', 1);
    await f.service.remove('demo', 2);

    const valid = await readFile(f.prefsPath, 'utf8');
    const connections = await readFile(file, 'utf8');

    await writeFile(f.prefsPath, '{broken');
    await assert.rejects(store.create({ ...input, projectId: 'demo' }), PrefsCorruptedError);
    await assert.rejects(store.update(existing.id, { projectId: 'demo' }), PrefsCorruptedError);
    assert.equal(await readFile(file, 'utf8'), connections);
    assert.equal(store.get(existing.id).projectId, 'other');
    await writeFile(f.prefsPath, valid);
    await assert.rejects(store.create({ ...input, projectId: 'demo' }), { code: 'project_not_found' });
    assert.equal((await listProjects(f.config, f.prefs)).includes('demo'), false);
  });
}
