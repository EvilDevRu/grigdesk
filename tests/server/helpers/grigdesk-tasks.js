import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { ProjectsError } from '../../../server/src/modules/projects/errors.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const moduleUrl = new URL('../../../server/src/modules/grigdesk-tasks/index.ts', import.meta.url);

export const TASK_INPUT = {
  title: 'Собственная постановка',
  description: '<текст>& без HTML',
  projectId: 'beta',
  clientOrigin: 'http://client.test:4321',
};

/**
 * HTTP-стенд использует настоящий модуль, когда он появится, и штатный 404 до реализации.
 * Отсутствие новой ручки проверяется HTTP-утверждением, а не ошибкой загрузки модуля.
 */
export async function tasksFixture(t, {
  configured = false,
  authenticated = true,
  root: supplied,
  configure = null,
} = {}) {
  const root = supplied || await mkdtemp(path.join(os.tmpdir(), 'own-tasks-'));
  const config = {};

  for (const key of [
    'stateDir', 'analysisDir', 'ticketsDir', 'sandboxJournalDir', 'factoryControlDir',
    'artifactsDir', 'profilesDir', 'factoryHome',
  ]) {
    config[key] = path.join(root, key);
    await mkdir(config[key], { recursive: true });
  }

  config.grigdeskTasksPath = path.join(root, 'tasks.json');
  config.sandboxManualRange = { from: 990000, to: 999999 };
  config.factoryProfile = 'alpha';

  const projects = ['alpha', 'beta', 'gamma'].map((id) => ({
    id,
    title: `Проект ${id}`,
    archivedAt: null,
    revision: 1,
    profile: { present: true },
    routes: ['feature'],
  }));

  for (const project of projects) {
    await mkdir(path.join(config.profilesDir, project.id), { recursive: true });
  }

  const portalCalls = [];
  const probes = [];
  const presence = new Map();
  const tracker = {
    isConfigured: () => configured,
    async probeTaskNumber(id) {
      probes.push(String(id));

      return presence.get(String(id)) || 'absent';
    },
    async taskDetail(id) {
      portalCalls.push(String(id));

      return {
        id: Number(id),
        title: 'Задача портала',
        description: 'Чужой текст'
      };
    },
    async taskPageData(id) {
      portalCalls.push(String(id));

      return { comments: [] };
    },
  };
  const factoryState = {
    discoverProfiles() {
      return projects.filter((project) => project.profile.present).map((project) => project.id);
    },
    async catalog(id) {
      return projects.find((project) => project.id === id)?.routes.length
        ? { routes: ['feature'], catalogHash: 'b'.repeat(64) }
        : null;
    },
  };
  const projectsService = {
    async list() {
      return projects;
    },
    async read(id) {
      const project = projects.find((entry) => entry.id === id);

      if (!project) {
        throw new ProjectsError(404, 'not_found', 'Проект удалён');
      }

      return project;
    },
    async withReferences(operation) {
      return operation();
    },
  };

  if (configure) {
    await configure(config);
  }

  const app = Fastify({ logger: false });
  const enqueued = [];
  const events = [];

  app.decorate('pluginEnabled', () => false);
  app.decorate('analyzer', {
    async enqueue(id) {
      enqueued.push(id);
    },
  });
  app.decorate('sse', {
    async broadcast(name, payload) {
      events.push({ name, payload });
    },
  });

  await app.register(authPlugin, {
    authStore: { isConfigured: () => true, isValidSession: () => authenticated },
    cliToken: authenticated ? 'test-task-token' : '',
    internalToken: '',
  });

  const moduleOptions = {
    config,
    tracker,
    factoryState,
    projectsService,
    prefs: { read: () => ({}) },
  };

  await registerTasksModule(app, moduleOptions);

  await app.ready();
  t.after(async () => {
    await app.close();

    if (!supplied) {
      await rm(root, { recursive: true, force: true });
    }
  });

  return {
    app,
    config,
    root,
    projects,
    portalCalls,
    probes,
    presence,
    moduleOptions,
    enqueued,
    events,
    create: (input = TASK_INPUT) => app.inject({
      method: 'POST',
      url: '/api/grigdesk-tasks',
      headers: { 'x-grigdesk-token': 'test-task-token' },
      payload: input,
    }),
  };
}

/**
 * Записывает документ согласованного контракта, общий для анализа и запуска.
 * Путь передаётся тем же config, из которого должен читать проверяемый потребитель.
 */
export async function seedTasks(config, tasks, nextId = '100000000010') {
  await writeFile(config.grigdeskTasksPath, JSON.stringify({
    schemaVersion: 1,
    revision: tasks.length,
    nextId,
    tasks,
  }));
}

/**
 * Эталон содержит только серверные поля собственной задачи из принятого контракта.
 * Потребители получают его через тот же файл config, без дубля текста в других настройках.
 */
export function ownTask(id = '100000000001', projectId = 'beta') {
  return {
    id,
    source: 'grigdesk',
    title: 'Собственная постановка',
    description: '<текст>& без HTML',
    projectId,
    projectTitle: `Проект ${projectId}`,
    sourceUrl: `http://client.test:4321/#/board?openTask=${id}`,
    createdAt: '2026-10-24T00:00:00.000Z',
  };
}

/**
 * Регистрация доступного продуктового модуля используется также настоящим TLS-стендом.
 * До реализации Fastify отвечает стандартным 404: тесты проверяют сетевой контракт.
 */
export async function registerTasksModule(app, options) {
  if (existsSync(moduleUrl)) {
    const { default: module } = await import(moduleUrl.href);

    await app.register(module, options);
  }
}
