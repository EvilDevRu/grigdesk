import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { projectRepos } from '../../server/src/lib/projects.ts';
import { resolveChatWorkdir } from '../../server/src/lib/chat/workdir.ts';
import {
  pdFixture, pdHistoryApp, pdSeedHistory, pdHistoryBytes, pdChat, pdDeferred, PD_CHOICE, PD_NOW,
} from './helpers/projects-deletion.js';

/**
 * Миграция завершена до внедрения ошибки и до снимка меты.
 * Предикат меняется вместе с finalize, как при настоящей записи tombstone.
 */
async function metaFixture(t) {
  const f = await pdFixture(t, { source: 'prefs' });
  let deleted = false;
  const history = new ChatHistoryStore({
    chatsDir: path.join(f.root, 'chats'),
    isProjectDeleted: (id) => deleted && id === 'demo',
  });

  await history.saveOne(pdChat('old'), false);
  await history.saveMeta({

    activeId: 'old',
    defMode: 'plan',
    defEffort: 'high',
    defWorkdir: PD_CHOICE,

    recentWorkdirs: [PD_CHOICE, { kind: 'path', path: f.extra }, { ...PD_CHOICE, projectId: 'other' }],

  });

  return {
    ...f,
    history,
    markDeleted: () => {
      deleted = true;
    }
  };
}

test('PD-meta: удаляется только default/recent указанного проекта', async (t) => {
  const f = await metaFixture(t);
  const before = await f.history.scan();
  let finalized = false;

  assert.equal(typeof f.history.withProjectPreferencesRemoved, 'function', 'очистка меты отсутствует');
  await f.history.withProjectPreferencesRemoved('demo', () => {
    const published = JSON.parse(requireRead(path.join(f.root, 'chats', 'meta.json'), 'utf8'));

    assert.deepEqual(published.defWorkdir, { kind: 'grigdesk' });
    assert.equal(published.recentWorkdirs.some((item) => item.projectId === 'demo'), false);
    finalized = true;
    f.markDeleted();
  });

  const meta = await f.history.readMetaRaw();

  assert.equal(finalized, true);
  assert.deepEqual(meta.defWorkdir, { kind: 'grigdesk' });
  assert.deepEqual(meta.recentWorkdirs, [
    { kind: 'path', path: f.extra }, { ...PD_CHOICE, projectId: 'other' },
  ]);
  assert.equal(meta.activeId, 'old');
  assert.equal(meta.defMode, 'plan');
  assert.equal(meta.defEffort, 'high');
  assert.deepEqual(await f.history.scan(), before);
});

test('PD-meta-race: поздний saveMeta не возвращает удалённый default', async (t) => {
  const f = await metaFixture(t);
  const entered = pdDeferred();
  const release = pdDeferred();
  const writeAtomic = f.history.writeAtomic.bind(f.history);
  let pause = true;

  assert.equal(typeof f.history.withProjectPreferencesRemoved, 'function', 'очистка меты отсутствует');
  f.history.writeAtomic = async (...args) => {
    if (pause && args[0].endsWith('meta.json')) {
      pause = false;
      entered.resolve();
      await release.promise;
    }

    return writeAtomic(...args);
  };

  const saving = f.history.saveMeta({ defEffort: 'low' });

  await entered.promise;

  const cleaning = f.history.withProjectPreferencesRemoved('demo', f.markDeleted);

  release.resolve();
  await Promise.all([saving, cleaning]);
  await f.history.saveMeta({
    defWorkdir: PD_CHOICE,
    recentWorkdirs: [PD_CHOICE],
    defMode: 'auto'
  });

  const meta = await f.history.readMetaRaw();

  assert.deepEqual(meta.defWorkdir, { kind: 'grigdesk' });
  assert.deepEqual(meta.recentWorkdirs, []);
  assert.equal(meta.defEffort, 'low');
  assert.equal(meta.defMode, 'auto');
});

for (const fault of ['json', 'EACCES']) {
  test(`PD-meta-read-error: повреждение меты не вызывает finalize (${fault})`, async (t) => {
    const f = await metaFixture(t);
    const file = path.join(f.root, 'chats', 'meta.json');
    let finalized = false;

    assert.equal(typeof f.history.withProjectPreferencesRemoved, 'function', 'строгая очистка отсутствует');

    if (fault === 'json') {
      await fs.writeFile(file, '{сломано');
    }

    const bytes = await fs.readFile(file);
    const readFile = fs.readFile.bind(fs);
    const mock = t.mock.method(fs, 'readFile', async (name, ...args) => {
      if (fault === 'EACCES' && String(name) === file) {
        throw Object.assign(new Error('нет доступа к мете'), { code: 'EACCES' });
      }

      return readFile(name, ...args);
    });

    await assert.rejects(f.history.withProjectPreferencesRemoved('demo', () => {
      finalized = true;
    }));
    mock.mock.restore();
    assert.equal(finalized, false);
    assert.equal((await fs.readFile(file)).equals(bytes), true);
    await fs.writeFile(file, '{}');
    await f.history.withProjectPreferencesRemoved('demo', () => {
      finalized = true;
    });
    assert.equal(finalized, true, 'очередь восстанавливается после reject');
  });
}

for (const source of ['profile', 'both']) {
  test(`PD-H-capture: до finalize записан снимок корней проекта (${source})`, async (t) => {
    const f = await pdFixture(t, { source });

    if (source === 'both') {
      const projects = f.prefs.readStored().projects;

      f.prefs.write({
        projects: {
          ...projects,
          demo: { ...projects.demo, repos: [{ key: 'main', dir: f.appRoot }] },
        }
      });
    }

    let hook;
    const service = {
      withReferences: (op) => op(),
      registerDeletionCleanup: (value) => {
        hook = value;
      },
    };
    const h = await pdHistoryApp(t, f, { projectsService: service });

    await h.app.ready();
    await pdSeedHistory(h, f);

    const bytes = await pdHistoryBytes(h);
    const actualRepos = await projectRepos({
      config: f.config,
      prefs: f.prefs,
      id: 'demo'
    });
    const expected = actualRepos.map(({ key, dir }) => ({ key, dir }));
    const file = path.join(h.config.chatsDir, 'project-workspaces.json');

    await fs.mkdir(h.config.chatsDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      version: 1, projects: {
        other: {
          revision: 3,
          repos: [],
          defaultRepoKey: null
        },
      }
    }));
    assert.equal(typeof hook, 'function', 'chatModule не зарегистрировал cleanup');

    let captured;

    await hook({ id: 'demo', revision: 7 }, () => {
      captured = JSON.parse(requireRead(file));
    });
    assert.deepEqual(captured.projects.demo, {

      revision: 7,
      repos: expected,
      defaultRepoKey: source === 'profile' ? null : 'main',

    });
    assert.deepEqual(await pdHistoryBytes(h), bytes);
    assert.deepEqual(captured.projects.other, {
      revision: 3,
      repos: [],
      defaultRepoKey: null
    });
  });
}

// finalize синхронный по контракту: читаем уже durable-файл без дополнительного await.
import { readFileSync as requireRead } from 'node:fs';

test('PD-H-scope: сохранённый снимок даёт прежние корни, task copies остаются первыми', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  const input = {

    config: { ...f.config, rootDir: f.appRoot },
    prefs: f.prefs,
    workdir: PD_CHOICE,

    provider: 'test',
    caps: { switch: 'resume', roots: 'multi' },

  };
  const before = await resolveChatWorkdir(input);

  f.prefs.write({
    projects: { other: f.prefs.readStored().projects.other },
    projectsMeta: { tombstones: { demo: { deletedAt: PD_NOW, revision: 3 } } }
  });

  const retainedProject = {
    id: 'demo',
    repos: f.repos,
    defaultRepoKey: 'main'
  };
  const retained = await resolveChatWorkdir({ ...input, retainedProject });

  assert.equal(retained.cwd, before.cwd);
  assert.deepEqual(retained.extraDirs, before.extraDirs);
  assert.equal(retained.workspaceKey, before.workspaceKey);

  const copies = await resolveChatWorkdir({

    ...input,
    retainedProject,
    taskId: '123',
    trustedProject: async () => 'demo',

    factoryState: {
      readEnv: async () => ({

        REPO_COUNT: '1',
        REPO_0_NAME: 'copy',
        WORKSPACE_MODE: 'isolated',

        REPO_0_WT: f.extra,
        REPO_0_SOURCE: f.main,
        REPO_0_BRANCH: 'copy',

      })
    },

  });

  assert.equal(copies.source, 'task-copies');
  assert.equal(copies.cwd, f.extra);
});

test('PD-H-failure: повреждённый снимок запрещает finalize и допускает повтор', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  let hook;
  const h = await pdHistoryApp(t, f, {
    projectsService: {
      withReferences: (op) => op(), registerDeletionCleanup: (value) => {
        hook = value;
      },
    }
  });

  await h.app.ready();
  await fs.mkdir(h.config.chatsDir, { recursive: true });

  const file = path.join(h.config.chatsDir, 'project-workspaces.json');

  await fs.writeFile(file, '{битый снимок');
  assert.equal(typeof hook, 'function', 'cleanup hook отсутствует');

  let finalized = false;

  await assert.rejects(hook({ id: 'demo', revision: 2 }, () => {
    finalized = true;
  }));
  assert.equal(finalized, false);
  assert.equal(await fs.readFile(file, 'utf8'), '{битый снимок');
  assert.equal(f.prefs.readStored().projectsMeta.tombstones.demo, undefined);
  await fs.writeFile(file, '{"version":1,"projects":{}}');
  await hook({ id: 'demo', revision: 2 }, () => {
    finalized = true;
  });
  assert.equal(finalized, true);
});

test('PD-H-legacy-store: удаление до импорта сохраняет оба legacy-чата', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  const h = await pdHistoryApp(t, f);

  await fs.writeFile(h.config.chatStoreLegacyPath, JSON.stringify({
    sessions: [pdChat('first'), pdChat('second')],
  }));
  await f.service.archive('demo', 1);

  const removal = await h.app.inject({

    method: 'DELETE',
    url: '/api/projects/demo',
    payload: { expectedRevision: 2 },

  });

  assert.equal(removal.statusCode, 204, removal.body);

  const history = (await h.app.inject('/api/chat/store')).json();

  assert.deepEqual(history.sessions.map((chat) => chat.id).sort(), ['first', 'second']);

  const rejected = await h.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: pdChat('new') },

  });

  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().error, 'workdir_unknown_project');
});

test('PD-H-reference-race: новый чат ждёт удаление и отвергается после tombstone', async (t) => {
  const f = await pdFixture(t, { source: 'prefs' });
  const entered = pdDeferred();
  const release = pdDeferred();
  const h = await pdHistoryApp(t, f);

  await f.service.archive('demo', 1);
  assert.equal(typeof f.service.withReferences, 'function', 'очередь ссылок отсутствует');

  const holding = f.service.withReferences(async () => {
    entered.resolve();
    await release.promise;
    f.prefs.write({ projectsMeta: { tombstones: { demo: { deletedAt: PD_NOW, revision: 3 } } } });
  });

  await entered.promise;

  const creating = h.app.inject({

    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: pdChat('new') },

  });

  release.resolve();
  await holding;

  const result = await creating;

  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().error, 'workdir_unknown_project');
});

for (const fault of ['write', 'meta']) {
  test(`PD-H-failure: ошибка ${fault} не даёт tombstone, повтор завершает удаление`, async (t) => {
    const f = await pdFixture(t, { source: 'prefs' });
    const h = await pdHistoryApp(t, f);

    await h.app.inject('/api/chat/store');
    await f.service.archive('demo', 1);
    assert.equal(typeof f.service.remove, 'function', 'remove отсутствует');

    const open = fs.open.bind(fs);
    const metaPath = path.join(h.config.chatsDir, 'meta.json');
    const readFile = fs.readFile.bind(fs);
    let fail = true;
    const openMock = t.mock.method(fs, 'open', async (file, ...args) => {
      if (fail && fault === 'write' && String(file).includes('project-workspaces')) {
        throw Object.assign(new Error('сбой durable записи'), { code: 'EACCES' });
      }

      return open(file, ...args);
    });
    const readMock = t.mock.method(fs, 'readFile', async (file, ...args) => {
      if (fail && fault === 'meta' && String(file) === metaPath) {
        throw Object.assign(new Error('сбой чтения меты'), { code: 'EACCES' });
      }

      return readFile(file, ...args);
    });

    await assert.rejects(f.service.remove('demo', 2), (error) => {
      assert.equal(error.code, 'deletion_incomplete');
      assert.match(error.message, fault === 'write' ? /снимок корней/ : /настройки чатов/);

      return true;
    });
    assert.equal(f.prefs.readStored().projects.demo.revision, 2);
    assert.equal(f.prefs.readStored().projectsMeta.tombstones.demo, undefined);
    fail = false;
    openMock.mock.restore();
    readMock.mock.restore();
    await f.service.remove('demo', 2);
    assert.equal(f.prefs.readStored().projectsMeta.tombstones.demo.revision, 3);
  });
}

test('PD-H-reference-race: summary свободен, finish после удаления не сбрасывает память', async (t) => {
  const { ChatWorkdirTransitions } = await import('../../server/src/lib/chat/workdirTransition.ts');
  const f = await pdFixture(t, { source: 'prefs' });
  const history = new ChatHistoryStore({ chatsDir: path.join(f.root, 'chats') });
  const chat = pdChat('moving', { kind: 'path', path: f.appRoot });

  await history.saveOne(chat, false);

  const entered = pdDeferred();
  const release = pdDeferred();
  const resets = [];
  const resolver = (record, selection = record) => resolveChatWorkdir({

    config: { ...f.config, rootDir: f.appRoot },
    prefs: f.prefs,

    workdir: selection.workdir,
    taskId: selection.taskId,

    provider: 'test',
    caps: { switch: 'reseed', roots: 'multi' },

    factoryState: { readEnv: async () => ({}) },
    trustedProject: async () => null,

    allowArchived: false,

  });

  assert.equal(typeof f.service.withReferences, 'function', 'очередь ссылок отсутствует');

  const transitions = new ChatWorkdirTransitions({

    history,
    busy: () => false,
    lock: (_id, op) => op(),

    withReferences: f.service.withReferences,

    resolve: resolver,
    capability: async () => ({ switch: 'reseed', roots: 'multi' }),

    memory: async (record) => ({ sessionId: 'old-session', workspace: await resolver(record) }),

    summary: async () => {
      entered.resolve();
      await release.promise;

      return 'Рабочая память';
    },

    reset: async () => {
      resets.push('reset');
    },
    notify() {
    },

  });
  const record = await history.readOne('moving');
  const candidate = { taskId: null, workdir: PD_CHOICE };
  const preview = await transitions.preview(record, candidate);
  const changing = transitions.change('moving', {

    ...candidate,
    operationId: 'delete-race',
    transfer: 'summary',

    expectedRevision: preview.revision,
    expectedWorkspaceKey: preview.workspaceKey,

  });

  try {
    await entered.promise;
    await f.service.archive('demo', 1);
    await f.service.remove('demo', 2);
  } finally {
    release.resolve();
  }

  await assert.rejects(changing);
  assert.deepEqual(resets, []);
  assert.equal((await history.readOne('moving')).workdir.path, f.appRoot);
});
