import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import routesModule from '../../server/src/modules/routes/index.ts';
import { makeAgentNode, makeDraft } from './routes-editor.mjs';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

export const sampleDirectory = path.resolve(import.meta.dirname, '../../server/seed/pipeline-sample');
export const scope = { kind: 'route', routeId: 'feature' };
export const capabilities = {
  schema: 1,
  commands: ['verify', 'recheck'].map((id) => ({
    id,
    label: id,
    filesystem: ['state-only'],
  })),
  contextSections: ['task', 'attempt', 'project', 'workspace', 'artifacts', 'evidence',
    'decisions', 'services', 'delivery', 'routeCatalog'].map((id) => ({ id, label: id })),
  filesystem: ['state-only', 'workspace-write'],
  timeoutClasses: ['standard', 'browser', 'delivery', 'check'],
  retryStrategies: ['none', 'runner-failover'],
};

/**
 * Читает инструкции тем же способом и из того же bundled sample, что будущий каталог.
 * Нормализуется только адрес профиля: заглушка образца не является настроенным профилем.
 */
export async function seedDraft({ minimal = false, directory = sampleDirectory } = {}) {
  const base = path.join(directory, 'profile/routes');
  const definitions = await import(pathToFileURL(path.join(base, 'definition.mjs')).href);
  const common = await import(pathToFileURL(path.join(base, 'common.mjs')).href);
  const draft = makeDraft();

  draft.routes = structuredClone(definitions.definitions);
  draft.bootstrap = structuredClone(definitions.bootstrap);
  draft.bootstrapPrompts = structuredClone(definitions.bootstrapPrompts);

  if (minimal) {
    const route = common.machine('feature', ['plan', 'build', 'gate_accept']);

    // В сокращённом feature нет tests, а seed всегда возвращает туда отказ build.
    // Для исходно валидного черновика отсутствующий адресат заменён решением человека.
    route.nodes.find((node) => node.id === 'build').onFailure.tests = { stop: 'human' };
    draft.routes.feature = { route, prompts: common.promptsFor(route) };
  }

  for (const entry of Object.values(draft.routes)) {
    entry.route.profile = draft.profile;
  }

  draft.bootstrap.profile = draft.profile;

  return draft;
}

/**
 * Синтетический transport получает только публичные шаблоны, без личного профиля.
 * Узлы и точные bytes берутся из definition/common, ответы остаются независимыми ожиданиями.
 */
export async function roleCatalog() {
  const draft = await seedDraft();
  /**
   * Выбирает только узел роли и его используемые блоки.
   * Ссылки остальных этапов и файлы профиля в transport не попадают.
   */
  const source = (routeId, nodeId) => {
    const entry = draft.routes[routeId];
    const node = structuredClone(entry.route.nodes.find((item) => item.id === nodeId));
    const prompts = Object.fromEntries((node.prompt?.blocks ?? [])
      .map((block) => [block.file, entry.prompts[block.file]]));

    return { node, prompts };
  };
  const defaults = {
    review: {
      filesystem: 'workspace-write',
      services: false,
      browser: false,
      failure: 'self-fix',
    },
    tests: {
      filesystem: 'workspace-write',
      services: false,
      browser: false,
      failure: 'ask',
    },
    browser: {
      filesystem: 'state-only',
      services: true,
      browser: true,
      failure: 'return',
    },
    human: {},
    command: { commandId: 'verify', filesystem: 'state-only' },
    custom: {
      filesystem: 'state-only',
      services: false,
      browser: false,
      failure: 'ask',
    },
  };
  const sources = {
    review: source('small', 'review'),
    tests: source('feature', 'tests'),
    browser: source('feature', 'browser'),
    human: source('feature', 'gate_accept'),
    command: source('feature', 'verify'),
    custom: { node: null, prompts: {} },
  };

  return {
    schema: 1,
    roles: Object.entries(sources).map(([id, template]) => ({
      id,
      ...template,
      defaults: defaults[id],
      ...(id === 'review' ? { companion: source('small', 'recheck') } : {}),
    })),
  };
}

/**
 * Изолирует профиль, authoring и поставляемый образец в одноразовой папке.
 * Никакие hooks не исполняются; auth моделирует общий серверный onRequest guard.
 */
export async function serverFixture(t, { auth = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-stage-wizard-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bundled = path.join(root, 'bundle');
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'sample');

  await fs.cp(sampleDirectory, bundled, { recursive: true });
  await fs.cp(path.join(bundled, 'profile'), profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'project.json'), JSON.stringify({ id: 'sample' }));

  const app = Fastify({ logger: false });

  if (auth) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers.authorization !== 'Bearer fixture') {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  await app.register(routesModule, {
    config: {
      profilesDir,
      routesDir: path.join(root, 'published'),
      routesAuthoringDir: path.join(root, 'authoring'),
      pipelineSampleDir: bundled,
    },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => assert.fail('Чтение каталога не изменяет prefs'),
    },
  });
  await app.ready();
  t.after(() => app.close());

  return {
    root,
    app,
    bundled,
    profileDir,
  };
}

/**
 * Создаёт документ штатным API и проверяет его настоящим валидатором редактора.
 * Ни исходный seed, ни capabilities в ответе validate не подменяются.
 */
export async function validateDraftThroughApi(app, draft) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document',
      title: 'Проверка мастера',
      baseCatalogHash: null,
      baseSourceRevision: 0,
      document: {
        routes: draft.routes,
        bootstrap: draft.bootstrap,
        bootstrapPrompts: draft.bootstrapPrompts,
        presentation: draft.presentation,
        provenance: draft.provenance,
      },
    },
  });

  assert.equal(created.statusCode, 201, created.body);

  const response = await app.inject({
    method: 'POST',
    url: `/api/routes/sample/drafts/${created.json().id}/validate`,
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);

  return response.json();
}

/**
 * Находит узел выбранного синтетического маршрута.
 * Другие маршруты каталога не участвуют во вставке.
 */
export function nodeAt(draft, id) {
  return draft.routes.feature.route.nodes.find((node) => node.id === id);
}

/**
 * Будущие операции проверяются внутри теста, поэтому отсутствие продукта даёт assert RED.
 * Компиляция существующего routeCommands сама по себе должна проходить на исходнике.
 */
export function requireWizardCommands(commands) {
  for (const name of ['prepareStageRole', 'listStageInsertionPlaces', 'insertStageRole']) {
    assert.equal(typeof commands[name], 'function', `Нет публичной операции ${name}`);
  }
}

/**
 * Применяет роль через публичную подготовку и команду, а не собственный сборщик теста.
 * Сигнатуры фиксируют намерение отдельно от документа и его текущих capabilities.
 */
export async function insertRole(commands, draft, roleId, afterId, answers = {}) {
  const catalog = await roleCatalog();
  const template = catalog.roles.find((role) => role.id === roleId);
  const prepared = commands.prepareStageRole(template, { ...template.defaults, ...answers }, capabilities);

  return commands.insertStageRole(draft, scope, afterId, prepared, capabilities);
}

/**
 * Два agent образуют настоящую пару по серверной схеме: worker стоит перед lead.
 * Вход ведёт в lead, продуктовые исходы worker передают управление только ему.
 */
export function loopDraft(draft) {
  const worker = makeAgentNode({ id: 'worker' });
  const lead = makeAgentNode({ id: 'lead' });

  worker.on = {
    done: { next: 'lead' },
    skipped: { next: 'lead' },
    failed: { next: 'lead' },
    exhausted: { stop: 'human' },
  };
  lead.on.done = { next: 'gate_accept' };
  lead.on.failed = { rewind: 'worker', reset: ['worker', 'lead'] };
  draft.routes.feature.route.loop = { lead: 'lead', worker: 'worker' };
  draft.routes.feature.route.entry = 'lead';
  draft.routes.feature.route.sequence.main = ['worker', 'lead', 'gate_accept'];
  draft.routes.feature.route.nodes = [worker, lead, nodeAt(draft, 'gate_accept'), nodeAt(draft, 'ship')];
  nodeAt(draft, 'gate_accept').on.rejected = {
    rewind: 'lead', reset: ['lead', 'gate_accept'],
  };
  draft.routes.feature.prompts['prompts/worker.base.md'] = 'Исполни поручение ведущего';
  draft.routes.feature.prompts['prompts/lead.base.md'] = 'Проверь результат исполнителя';

  const files = new Set(draft.routes.feature.route.nodes.flatMap((node) =>
    node.prompt?.blocks.map((block) => block.file) ?? []));

  draft.routes.feature.prompts = Object.fromEntries(Object.entries(draft.routes.feature.prompts)
    .filter(([file]) => files.has(file)));

  return draft;
}
