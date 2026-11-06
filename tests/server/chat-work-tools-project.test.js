import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createPermissionQueue } from '../../server/src/lib/chat/permissionQueue.ts';
import { ChatProjectWorkspaces } from '../../server/src/lib/chat/projectWorkspaces.ts';
import { createSshBroker } from '../../server/src/lib/ssh/broker.ts';
import { chatAppFixture, TEST_MODEL_REF, waitFor } from './helpers/chat-turns.js';

const PROJECT_WORKDIR = Object.freeze({
  kind: 'project',
  projectId: 'project-a',
  repoKey: null,
});
const TIME_COMMAND = Object.freeze({
  action: 'exec',
  label: 'Сервер project-a',
  role: 'web',
  command: 'date -Is',
});

/**
 * Настоящий маршрут чата и SSH-брокер работают с синтетическими сессиями.
 * Очередь подтверждений настоящая, а команды только записываются в массив.
 */
async function fixture(t) {
  const prefs = { projects: {} };
  const queue = createPermissionQueue({ timeoutMs: 2000 });
  const runs = [];
  const executions = [];
  const dbScopes = [];
  const sessions = ['project-a', 'project-b'].map((projectId) => ({
    id: `session-${projectId}`,
    projectId,
    label: `Сервер ${projectId}`,
    role: 'web',
    host: 'server.example',
    port: 22,
    user: 'deploy',
    agentAllowed: true,
    generation: 1,
  }));

  sessions.push({
    ...sessions[0],
    id: 'hidden-session',
    label: 'Без допуска',
    agentAllowed: false,
  });

  const broker = createSshBroker({
    pluginEnabled: () => true,
    permissionQueue: queue,
    sessions: {
      listForAgent(projectId) {
        return sessions.filter((session) => session.projectId === projectId && session.agentAllowed);
      },
      async exec(id, command) {
        executions.push({ id, command });

        return {
          ok: true,
          output: 'synthetic-time',
          exitCode: 0,
        };
      },
    },
  });
  let command = null;
  let taskProject = null;
  const executor = {
    id: TEST_MODEL_REF.provider,
    workdir: { switch: 'resume', roots: 'multi' },
    /**
     * Наблюдает scope на границе реально запущенного исполнителя.
     * Подставленный projectId в аргументах модели не должен менять сохранённый выбор.
     */
    async run(options) {
      runs.push(options);

      const list = await options.workTools.invoke('supervised_ssh', {
        action: 'list',
        projectId: 'project-b',
      });
      const databases = await options.workTools.invoke('supervised_db', { action: 'list' });
      const result = command
        ? await options.workTools.invoke('supervised_ssh', command)
        : null;

      return {
        reply: JSON.stringify({
          list,
          databases,
          result,
        }),
        steps: [],
        sessionId: 'test-session',
      };
    },
  };
  const f = await chatAppFixture(t, {
    executor,
    prefs,
    /**
     * Оба зарегистрированных проекта используют один физический каталог.
     * Подключения и настройки существуют только внутри временной фикстуры.
     */
    async beforeChat(app, { root, config }) {
      config.profilesDir = path.join(root, 'profiles');
      await fs.mkdir(config.profilesDir);
      prefs.projects = Object.fromEntries(['project-a', 'project-b'].map((id) => [id, {
        repos: [{ key: 'main', dir: root }],
      }]));
      app.decorate('pluginEnabled', () => true);
    },
    syntheticPorts: {
      permissionQueue: queue,
      sshBroker: broker,
      dbBroker: {
        async invoke(scope) {
          dbScopes.push(scope.projectId);

          return [];
        },
      },
      factoryState: {
        readEnv: async () => ({}),
        readTrustedAttempt: async () => taskProject ? { profile: taskProject } : null,
      },
    },
  });

  return {
    ...f,
    queue,
    runs,
    executions,
    dbScopes,
    prefs,
    setCommand(value) {
      command = value;
    },
    setTaskProject(value) {
      taskProject = value;
    },
  };
}

/**
 * Начальный выбор сохраняется через API истории, как перед первым ходом окна.
 * Позднейшие смены проекта проходят отдельный протокол перехода с CAS.
 */
async function saveChat(f, workdir, taskId = null) {
  const response = await f.app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: 'scope-chat',
        modelRef: TEST_MODEL_REF,
        messages: [],
        taskId,
        workdir,
        createdAt: Date.now(),
      },
    },
  });

  assert.equal(response.statusCode, 200, response.body);
}

/**
 * Ход использует сохранённую запись; контекст и дополнительные поля тела
 * намеренно называют другой проект и не должны менять надзорную область.
 */
async function send(f, taskId = null) {
  const response = await f.app.inject({
    method: 'POST',
    url: taskId ? `/api/tasks/${taskId}/chat` : '/api/chat',
    payload: {
      chatKey: 'scope-chat',
      modelRef: TEST_MODEL_REF,
      message: 'Запроси время',
      mode: 'auto',
      projectId: 'project-b',
      context: { page: 'Проект', path: '/projects/project-b' },
    },
  });

  assert.equal(response.statusCode, 200, response.body);

  return JSON.parse(response.json().reply);
}

/**
 * Выбор меняется через реальный предпросмотр и подтверждение перехода.
 * Оба проекта имеют один cwd: проверяется именно смена полномочий проекта.
 */
async function changeProject(f, projectId) {
  const candidate = {
    taskId: null,
    workdir: {
      kind: 'project',
      projectId,
      repoKey: null,
    },
  };
  const preview = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/preview',
    payload: { chatKey: 'scope-chat', candidate },
  });

  assert.equal(preview.statusCode, 200, preview.body);

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat/workdir/change',
    payload: {
      chatKey: 'scope-chat',
      ...candidate,
      operationId: `select-${projectId}`,
      transfer: 'resume',
      expectedRevision: preview.json().revision,
      expectedWorkspaceKey: preview.json().workspaceKey,
    },
  });

  assert.equal(response.statusCode, 200, response.body);
}

test('свободный чат видит разрешённые SSH-сессии сохранённого проекта', async (t) => {
  const f = await fixture(t);

  await saveChat(f, PROJECT_WORKDIR);

  const result = await send(f);

  assert.deepEqual(result.list, [{ label: 'Сервер project-a', role: 'web' }]);
  assert.deepEqual(f.dbScopes, ['project-a']);
  assert.equal(f.executions.length, 0);
  assert.equal(f.queue.waiting().length, 0);
});

test('команда свободного чата в auto ждёт отдельного решения каждый раз', async (t) => {
  const f = await fixture(t);

  await saveChat(f, PROJECT_WORKDIR);
  f.setCommand(TIME_COMMAND);

  const allowedTurn = send(f);
  const first = await waitFor(() => f.queue.waiting().find((entry) => entry.origin === 'ssh'));

  assert.equal(f.executions.length, 0);
  assert.equal(first.canRemember, false);
  assert.equal(first.presentation.command, 'date -Is');
  await f.queue.answer(first.pid, 'ssh', { allow: true });
  assert.equal((await allowedTurn).result.ok, true);
  assert.deepEqual(f.executions, [{ id: 'session-project-a', command: 'date -Is' }]);

  const deniedTurn = send(f);
  const second = await waitFor(() => f.queue.waiting().find((entry) => entry.origin === 'ssh'));

  assert.notEqual(second.pid, first.pid);
  assert.equal(second.canRemember, false);
  await f.queue.answer(second.pid, 'ssh', { allow: false, comment: 'Не выполнять повторно' });
  assert.equal((await deniedTurn).result.error, 'denied');
  assert.equal(f.executions.length, 1);
});

test('смена проекта меняет SSH-область и ключ сессии при прежнем cwd', async (t) => {
  const f = await fixture(t);

  await saveChat(f, PROJECT_WORKDIR);

  const first = await send(f);

  await changeProject(f, 'project-b');

  const second = await send(f);

  assert.deepEqual(first.list, [{ label: 'Сервер project-a', role: 'web' }]);
  assert.deepEqual(second.list, [{ label: 'Сервер project-b', role: 'web' }]);
  assert.equal(f.runs[0].cwd, f.runs[1].cwd);
  assert.notEqual(f.runs[0].workToolScopeKey, f.runs[1].workToolScopeKey);
  assert.deepEqual(f.dbScopes, ['project-a', 'project-b']);

  f.setCommand(TIME_COMMAND);
  assert.equal((await send(f)).result.error, 'not_available');
  assert.equal(f.queue.waiting().length, 0);
  assert.equal(f.executions.length, 0);
});

test('обычный путь к репозиторию не даёт проектный SSH-доступ', async (t) => {
  const f = await fixture(t);

  await saveChat(f, { kind: 'path', path: f.root });
  f.setCommand(TIME_COMMAND);

  const result = await send(f);

  assert.deepEqual(result.list, []);
  assert.equal(result.result.error, 'project_scope_unavailable');
  assert.deepEqual(f.dbScopes, []);
  assert.equal(f.queue.waiting().length, 0);
});

test('задача использует доверенный проект и не откатывается к выбору чата', async (t) => {
  const f = await fixture(t);

  f.setTaskProject('project-b');
  await saveChat(f, PROJECT_WORKDIR, '44');

  assert.deepEqual((await send(f, '44')).list, [{ label: 'Сервер project-b', role: 'web' }]);

  f.setTaskProject(null);

  assert.deepEqual((await send(f, '44')).list, []);
  assert.deepEqual(f.dbScopes, ['project-b']);
});

test('удалённый проект сохраняет историческую папку без надзорного доступа', async (t) => {
  const f = await fixture(t);

  await saveChat(f, PROJECT_WORKDIR);
  assert.equal((await send(f)).list.length, 1);

  await new ChatProjectWorkspaces(f.config.chatsDir).capture('project-a', {
    revision: 0,
    repos: [{ key: 'main', dir: f.root }],
    defaultRepoKey: 'main',
  });
  delete f.prefs.projects['project-a'];
  f.prefs.projectsMeta = {
    tombstones: {
      'project-a': { deletedAt: '2026-01-01T00:00:00.000Z', revision: 1 },
    },
  };
  f.setCommand(TIME_COMMAND);

  const result = await send(f);

  assert.deepEqual(result.list, []);
  assert.equal(result.result.error, 'project_scope_unavailable');
  assert.deepEqual(f.dbScopes, ['project-a']);
  assert.equal(f.queue.waiting().length, 0);
  assert.equal(f.executions.length, 0);
});
