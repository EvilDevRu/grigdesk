import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { createProjectsService } from '../../server/src/modules/projects/service.ts';
import {
  pdFixture, pdHistoryApp, pdSeedHistory, pdAssertHistory, pdHistoryBytes,
  pdChat, pdDeferred, PD_CHOICE, PD_PNG,
} from './helpers/projects-deletion.js';

test('PD-H1: DELETE сохраняет содержимое старого разговора после рестарта', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  const h = await pdHistoryApp(t, f);
  const ref = await pdSeedHistory(h, f);

  await f.service.archive('demo', 1);
  await fs.mkdir(path.join(h.config.chatsDir, '1970-01'), { recursive: true });
  await fs.writeFile(path.join(h.config.chatsDir, '1970-01', 'unrelated.json'), '{битый чужой чат');

  const before = await pdHistoryBytes(h);
  const removed = await h.app.inject({

    method: 'DELETE',
    url: '/api/projects/demo',
    payload: { expectedRevision: 2 },

  });

  assert.equal(removed.statusCode, 204, removed.body);
  assert.deepEqual(await pdHistoryBytes(h), before);
  await pdAssertHistory(h, f, ref);

  const meta = f.prefs.readStored().projectsMeta;

  f.prefs.write({
    projectsMeta: {
      ...meta, tombstones: { ...meta.tombstones, demo: { ...meta.tombstones.demo, revision: 99 } },
    }
  });

  const wrongRevision = await h.app.inject('/api/chat/legacy/image?path=image.png');

  assert.equal(wrongRevision.statusCode, 404, wrongRevision.body);
  f.prefs.write({ projectsMeta: meta });
  await h.app.close();
  f.service = createProjectsService({ config: f.config, prefs: f.prefs });

  const restarted = await pdHistoryApp(t, f);

  assert.deepEqual(await pdHistoryBytes(restarted), before);
  await pdAssertHistory(restarted, f, ref);

  const forged = pdChat('forged');

  forged.workdirState = { committed: { cwd: f.main, extraDirs: [f.extra] } };

  const put = await restarted.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: forged },

  });

  assert.equal(put.statusCode, 409, put.body);
  assert.equal(put.json().error, 'workdir_unknown_project');

  const preview = await restarted.app.inject({

    method: 'POST',
    url: '/api/chat/workdir/preview',

    payload: { chatKey: 'neighbor', candidate: { taskId: null, workdir: PD_CHOICE } },

  });

  assert.equal(preview.statusCode, 409, preview.body);

  for (const [id, cwd, extra] of [['legacy', f.main, f.extra], ['explicit', f.extra, f.main]]) {
    const turn = await restarted.app.inject({

      method: 'POST',
      url: '/api/chat',

      payload: {
        chatKey: id,
        modelRef: {
          provider: 'test-provider',
          model: 'test-model'
        },
        message: 'Дальше'
      },

    });

    assert.equal(turn.statusCode, 200, turn.body);
    assert.equal(restarted.runs.at(-1).cwd, cwd);
    assert.equal(restarted.runs.at(-1).extraDirs.includes(extra), true);
  }
});

test('PD-H-legacy-inflight-delete: удаление во время импорта сохраняет оба разговора', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  const h = await pdHistoryApp(t, f);

  for (const dir of [f.main, f.extra]) {
    await fs.writeFile(path.join(dir, 'image.png'), PD_PNG);
    await fs.writeFile(path.join(dir, 'document.md'), '# Старый документ\n');
  }

  await fs.writeFile(h.config.chatStoreLegacyPath, JSON.stringify({
    sessions: [pdChat('first'), pdChat('second', { ...PD_CHOICE, repoKey: 'extra' })],
  }));
  await f.service.archive('demo', 1);

  const entered = pdDeferred();
  const release = pdDeferred();
  const saveOne = ChatHistoryStore.prototype.saveOne;
  let commits = 0;

  t.mock.method(ChatHistoryStore.prototype, 'saveOne', async function(...args) {
    const result = await saveOne.apply(this, args);

    commits += 1;

    if (commits === 1) {
      entered.resolve();
      await release.promise;
    }

    return result;
  });

  const reading = h.app.inject('/api/chat/store');

  try {
    await entered.promise;

    const removed = await h.app.inject({

      method: 'DELETE',
      url: '/api/projects/demo',
      payload: { expectedRevision: 2 },

    });

    assert.equal(removed.statusCode, 204, removed.body);
  } finally {
    release.resolve();
    await reading;
  }

  await h.app.close();
  f.service = createProjectsService({ config: f.config, prefs: f.prefs });

  const restarted = await pdHistoryApp(t, f);
  const store = (await restarted.app.inject('/api/chat/store')).json();

  assert.deepEqual(store.sessions.map((chat) => chat.id).sort(), ['first', 'second']);
  assert.deepEqual(store.sessions.map((chat) => chat.messages[0].text).sort(),
    ['first сообщение 0', 'second сообщение 0']);

  for (const id of ['first', 'second']) {
    const image = await restarted.app.inject(`/api/chat/${id}/image?path=image.png`);

    assert.equal(image.statusCode, 200, image.body);
    assert.equal(image.rawPayload.equals(PD_PNG), true);

    const file = path.join(id === 'first' ? f.main : f.extra, 'document.md');
    const resolved = await restarted.reader.resolveAbsolute(file, `chat:${id}`);

    assert.equal((await restarted.reader.read(resolved.ref)).content, '# Старый документ\n');
  }

  const rejected = await restarted.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: pdChat('new') },

  });

  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().error, 'workdir_unknown_project');
  assert.equal(await fs.stat(h.config.chatStoreLegacyPath).then(() => true, () => false), false);
  assert.equal((await f.service.list()).some((project) => project.id === 'demo'), false);
});

for (const copies of [false, true]) {
  test(`PD-H1: trusted task-project сохраняет область после DELETE (copies=${copies})`, async (t) => {
    const f = await pdFixture(t, { source: 'prefs' });
    const factoryState = {
      readRegistry: async () => ({ registry: {} }),
      readTrustedAttempt: async () => ({ profile: 'demo' }),
      readEnv: async () => copies ? {
        WORKSPACE_MODE: 'isolated',

        REPO_COUNT: '1',
        REPO_0_NAME: 'copy',
        REPO_0_WT: f.extra,

        REPO_0_SOURCE: f.main,
        REPO_0_BRANCH: 'copy',

      } : { WORKSPACE_MODE: 'isolated' },
    };
    const h = await pdHistoryApp(t, f, { factoryState });
    const chat = { ...pdChat('task-chat', { kind: 'grigdesk' }), taskId: '123' };
    const saved = await h.app.inject({

      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: { chat },

    });

    assert.equal(saved.statusCode, 200, saved.body);

    for (const dir of [f.main, f.extra]) {
      await fs.writeFile(path.join(dir, 'image.png'), PD_PNG);
    }

    const imageUrl = '/api/chat/task-chat/image?path=image.png';
    const before = await h.app.inject(imageUrl);

    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.rawPayload.equals(PD_PNG), true);
    await f.service.archive('demo', 1);

    const deleted = await h.app.inject({

      method: 'DELETE',
      url: '/api/projects/demo',
      payload: { expectedRevision: 2 },

    });

    assert.equal(deleted.statusCode, 204, deleted.body);

    const after = await h.app.inject(imageUrl);

    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.rawPayload.equals(PD_PNG), true);

    const turn = await h.app.inject({

      method: 'POST',
      url: '/api/tasks/123/chat',

      payload: {
        chatKey: 'task-chat',
        modelRef: {
          provider: 'test-provider',
          model: 'test-model'
        },
        message: 'Дальше'
      },

    });

    assert.equal(turn.statusCode, 200, turn.body);
    assert.equal(h.runs.at(-1).cwd, copies ? f.extra : f.main);
  });
}

for (const endpoint of ['put', 'ensure']) {
  test(`PD: история задачи создаётся без чтения стенда (${endpoint})`, async (t) => {
    const f = await pdFixture(t, { source: 'prefs' });
    const h = await pdHistoryApp(t, f, {
      factoryState: {
        readEnv: async () => {
          assert.fail('Создание истории не читает исполнительскую рабочую область');
        },
        readRegistry: async () => ({ registry: {} }),
        readTrustedAttempt: async () => null,
      },
    });
    const request = endpoint === 'put'
      ? {
        method: 'PUT',
        url: '/api/chat/store/chat',
        payload: { chat: { ...pdChat('task-chat', { kind: 'grigdesk' }), taskId: '123' } },
      }
      : {
        method: 'POST',
        url: '/api/chat/store/ensure',
        payload: { purpose: 'companion', taskId: '123' },
      };
    const response = await h.app.inject(request);

    assert.equal(response.statusCode, 200, response.body);
  });
}

test('PD: успешно прочитанный пустой профиль допускает удаление регистрации', async (t) => {
  const f = await pdFixture(t, { source: 'profile' });
  const h = await pdHistoryApp(t, f);

  await fs.writeFile(path.join(f.profilesDir, 'demo', 'profile.sh'), 'PROFILE_TRIAGE_REPOS=""\n');
  await f.service.archive('demo', 0);

  const removed = await h.app.inject({
    method: 'DELETE',
    url: '/api/projects/demo',
    payload: { expectedRevision: 1 },
  });

  assert.equal(removed.statusCode, 204, removed.body);

  const snapshot = JSON.parse(await fs.readFile(
    path.join(h.config.chatsDir, 'project-workspaces.json'), 'utf8',
  ));

  assert.deepEqual(snapshot.projects.demo.repos, []);
});

for (const broken of ['return 1\n', 'exit 0\n']) {
  test(`PD: сбой профиля оставляет регистрацию для повтора (${broken.trim()})`, async (t) => {
    const f = await pdFixture(t, { source: 'profile' });
    const h = await pdHistoryApp(t, f);
    const file = path.join(f.profilesDir, 'demo', 'profile.sh');
    const original = await fs.readFile(file, 'utf8');

    await fs.writeFile(path.join(f.extra, 'image.png'), PD_PNG);

    const saved = await h.app.inject({
      method: 'PUT',
        url: '/api/chat/store/chat',
      payload: { chat: pdChat('old') },
    });

    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal((await h.app.inject('/api/chat/old/image?path=image.png')).statusCode, 200);
    await f.service.archive('demo', 0);
    // Кэш ещё свежий: удаление обязано проверить профиль заново.
    await fs.writeFile(file, broken);

    const request = {
      method: 'DELETE',
      url: '/api/projects/demo',
      payload: { expectedRevision: 1 },
    };
    const failed = await h.app.inject(request);

    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(failed.json().error, 'deletion_incomplete');
    assert.match(failed.json().message, /снимок корней/u);
    assert.ok(f.prefs.readForWrite().projects.demo.archivedAt);
    assert.equal(f.prefs.readForWrite().projectsMeta.tombstones.demo, undefined);
    assert.equal(f.events.some(({ data }) => data.kind === 'deleted'), false);
    await fs.writeFile(file, original);

    const removed = await h.app.inject(request);

    assert.equal(removed.statusCode, 204, removed.body);

    const snapshot = JSON.parse(await fs.readFile(
      path.join(h.config.chatsDir, 'project-workspaces.json'), 'utf8',
    ));

    assert.deepEqual(snapshot.projects.demo.repos, f.repos);
    assert.equal((await h.app.inject('/api/chat/old/image?path=image.png')).statusCode, 200);
    assert.equal((await h.app.inject(request)).statusCode, 204);
  });
}
