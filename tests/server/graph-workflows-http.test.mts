import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import { INBOX_REF_LIMITS } from '../../server/src/lib/inbox/identity.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import ssePlugin from '../../server/src/plugins/sse.ts';
import graphWorkflows from '../../server/src/modules/graphWorkflows/index.ts';
import type { GraphClaimJob } from '../../server/src/modules/graphWorkflows/index.ts';
import { runGraphModel } from '../../server/src/lib/graphWorkflowExecutor.ts';
import { graphCommand } from '../../server/src/lib/graphWorkflows.ts';
import { createGraphModelCatalog } from '../../server/src/lib/graphWorkflowCatalog.ts';
import { buildTestGo } from '../helpers/goBuildFixture.mts';
import type { WorkflowRow } from '../../shared/pipeline/graphWorkflowContracts.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const fastify = requireServer('fastify');
const factoryBin = process.env.TEST_GRAPH_FACTORY_BIN
  ?? buildTestGo('graph-factory', ['build'], './utilities/factory/cmd/factory');

interface ClaimFixture {
  job: {
    id: string; nodeId: string; generation: number; claimId: string; rows: WorkflowRow[];
    kind: 'agent' | 'meetingTasks'; prompt?: string; feedback?: string; expiresAt: number;
  } | null;
  changed: { id: string; revision?: number }[];
  pending: boolean;
  nextWakeAt?: number;
}

interface GraphTestApp {
  app: ReturnType<typeof fastify>;
  headers: { cookie: string };
  config: { rootDir: string; factoryControlDir: string; factoryBin: string; modelsPath: string };
  root: string;
}

async function openGraphTestApp(t: { after: (fn: () => Promise<void>) => void }, root: string, opts: {
  autoWork?: boolean;
  runModel?: (job: unknown, signal: AbortSignal) => Promise<unknown>;
} = {}): Promise<GraphTestApp> {
  const app = fastify({
    bodyLimit: 64 * 1024 ** 2,
    maxParamLength: INBOX_REF_LIMITS.encodedChars,
  });
  t.after(async () => {
    await app.close();
  });

  const auth = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });
  const token = auth.createSession().id;
  await app.register(authPlugin, {
    authStore: auth,
    internalToken: 'test-internal',
  });
  const stateDir = path.join(root, 'sse');
  await mkdir(stateDir, { recursive: true });
  await app.register(ssePlugin, { stateDir });
  const config = {
    rootDir: process.cwd(),
    factoryControlDir: path.join(root, 'control'),
    factoryBin,
    modelsPath: path.join(root, 'models.json'),
  };
  await app.register(graphWorkflows, {
    config,
    modelCatalog: {
      list: async () => [{ provider: 'claude', model: 'fake', label: 'Тестовая модель' }],
      resolve: async (value: { provider: string; model: string }) =>
        value.provider === 'claude' && value.model === 'fake' ? value : null,
    },
    runModel: (opts.runModel ?? (async () => ({ rows: [] }))) as never,
    autoWork: opts.autoWork ?? false,
  });
  const headers = { cookie: 'grigdesk_sid=' + token };

  return { app, headers, config, root };
}

async function testGraphApp(t: { after: (fn: () => Promise<void>) => void }, opts: {
  autoWork?: boolean;
  runModel?: (job: unknown, signal: AbortSignal) => Promise<unknown>;
} = {}): Promise<GraphTestApp> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'grigdesk-graph-http-')));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return openGraphTestApp(t, root, opts);
}

test('сессионный старт из редакции идемпотентен и не зависит от наличия проекта Git', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const list = await app.inject({ method: 'GET', url: '/api/graph-workflows/templates', headers });
  assert.equal(list.statusCode, 200);
  const template = list.json().templates.find((item: { id: string }) => item.id === 'builtin-documents');
  assert.ok(template);

  const payload = {
    id: 'd11dce6a-b7cc-4654-96b4-3ea48ed46a81',
    templateId: template.id,
    expectedRevision: template.revision,
    modelRef: { provider: 'claude', model: 'fake' },
    files: [{ name: 'alpha.md', text: '# Alpha\nСтрока' }],
  };
  const url = '/api/graph-workflows/runs';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  const first = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().id, payload.id);

  const replay = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().id, payload.id);
  const changed = { ...payload, files: [{ name: 'alpha.md', text: 'Другой исходник' }] };
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: changed })).statusCode, 409);

  const graph = await app.inject({ method: 'GET', url: url + '/' + payload.id, headers });
  assert.equal(graph.statusCode, 200);
  assert.ok(graph.json().nodes.some((node: { id: string }) => node.id === 'files.1.parts.1.summary'));
  assert.equal(graph.body.includes('Строка'), false);
});

test('не сессионный токен не пишет и не читает графовые данные', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const internal = { 'x-grigdesk-internal': 'test-internal' };
  const list = await app.inject({ method: 'GET', url: '/api/graph-workflows/templates', headers: internal });
  assert.equal(list.statusCode, 403);
  assert.equal(list.json().error, 'session_required');
  const save = await app.inject({
    method: 'POST', url: '/api/graph-workflows/templates/save', headers: internal,
    payload: {
      id: 'a2372fd2-e591-41c8-964a-64d321e3c677', expectedRevision: null,
      document: { title: 'X', inputKind: 'documents', scope: { returns: ['s'], steps: [{ id: 's', title: 'S', kind: 'input' }] } },
    },
  });
  assert.equal(save.statusCode, 403);
  const sessionList = await app.inject({ method: 'GET', url: '/api/graph-workflows/templates', headers });
  assert.equal(sessionList.json().templates.length, 2);
});

test('сохранение поверх встроенного ID отклоняется без записи', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const document = { title: 'Клон', inputKind: 'documents', scope: { returns: ['s'], steps: [{ id: 's', title: 'S', kind: 'input' }] } };
  const save = await app.inject({
    method: 'POST', url: '/api/graph-workflows/templates/save', headers,
    payload: { id: 'builtin-documents', expectedRevision: null, document },
  });
  assert.equal(save.statusCode, 422);
  assert.equal(save.json().error, 'builtin_readonly');
  assert.equal(save.json().field, 'id');
  const repeat = await app.inject({
    method: 'POST', url: '/api/graph-workflows/templates/save', headers,
    payload: { id: 'builtin-documents', expectedRevision: null, document },
  });
  assert.equal(repeat.statusCode, 422);
  const list = await app.inject({ method: 'GET', url: '/api/graph-workflows/templates', headers });
  assert.equal(list.json().templates.length, 2);
});

test('две выдачи из двух процессов принимаются в обратном порядке', async (t) => {
  const { app, headers, config, root } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const templates = (await app.inject({ method: 'GET', url: prefix + '/templates', headers })).json();
  const template = templates.templates.find((item: { id: string }) => item.id === 'builtin-documents');
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';
  const start = await app.inject({
    method: 'POST', url: prefix + '/runs', headers,
    payload: {
      id, templateId: template.id, expectedRevision: template.revision,
      modelRef: { provider: 'claude', model: 'fake' },
      files: [{ name: 'a.md', text: '# A\nодин' }, { name: 'b.md', text: '# B\nдва' }],
    },
  });
  assert.equal(start.statusCode, 202);

  const [one, two] = await Promise.all([
    graphCommand(config, 'claim', {}) as Promise<ClaimFixture>,
    graphCommand(config, 'claim', {}) as Promise<ClaimFixture>,
  ]);
  assert.ok(one.job && two.job);
  assert.notEqual(one.job.nodeId, two.job.nodeId);
  const third = await graphCommand(config, 'claim', {}) as ClaimFixture;
  assert.equal(third.job, null);

  const settle = (job: NonNullable<ClaimFixture['job']>, key: string) => graphCommand(config, 'settle', {
    id: job.id, nodeId: job.nodeId, generation: job.generation, claimId: job.claimId,
    rows: [{ key, title: key, text: 'готово ' + key, sources: job.rows[0]?.sources ?? [] }],
  });
  await settle(two.job, 'r2');
  await settle(one.job, 'r1');

  await app.close();
  const reopened = await openGraphTestApp(t, root);
  const graph = await reopened.app.inject({ method: 'GET', url: prefix + '/runs/' + id, headers: reopened.headers });
  assert.equal(graph.statusCode, 200);
  assert.equal(graph.json().status, 'done');
  const result = await reopened.app.inject({ method: 'GET', url: prefix + '/runs/' + id + '/result', headers: reopened.headers });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().rows.map((row: WorkflowRow) => row.title).sort(), ['r1', 'r2']);
  assert.deepEqual(result.json().missing, []);
});

test('все 50 элементов запускаются до первого завершения дочернего вызова', async (t) => {
  const entered = new Set<string>();
  const release = Promise.withResolvers<void>();
  const fixtureRows = Array.from({ length: 50 }, (_, index) => ({
    title: 'Компания ' + (index + 1),
    text: 'Синтетические данные',
    line: 1,
  }));

  // Источник проходит настоящий разбор ответа модели, листья ждут общего барьера.
  const runModel = async (raw: unknown, signal: AbortSignal) => {
    const job = raw as GraphClaimJob;

    if (job.nodeId === 'search') {
      return runGraphModel(job, {
        config: {},
        signal,
        resolveTarget: async () => ({
          ok: true,
          ref: job.modelRef,
          executor: { runUntrusted: async () => ({ reply: JSON.stringify({ rows: fixtureRows }) }) },
        }),
      });
    }
    entered.add(job.nodeId);
    await release.promise;

    return { rows: job.rows };
  };
  const { app, headers } = await testGraphApp(t, { autoWork: true, runModel });
  const prefix = '/api/graph-workflows';
  const id = '3682bb0c-6b74-43f0-b1dc-b16ca4075c13';
  const url = prefix + '/runs/' + id;
  const save = await app.inject({
    method: 'POST', url: prefix + '/templates/save', headers,
    payload: { id: '465658d3-2aaf-4b47-b161-40adff9febd2', expectedRevision: null, document: {
      title: 'Рынок', inputKind: 'documents',
      scope: { returns: ['each'], steps: [
        { id: 'search', title: 'Поиск', kind: 'agent', prompt: 'Составь список', reads: ['$inputs'] },
        { id: 'each', title: 'Разбор', kind: 'forEach', needs: ['search'], source: 'search',
          scope: { returns: ['study'], steps: [
            { id: 'study', title: 'Компания', kind: 'agent', prompt: 'Изучи', reads: ['$item'] },
          ] } },
      ] },
    } },
  });
  assert.equal(save.statusCode, 200, save.body);
  const template = save.json();

  // Поллинг ограничен временем и не удерживает модельные вызовы после ошибки теста.
  const waitForRun = async (predicate: (graph: { status: string }) => boolean) => {
    const deadline = Date.now() + 15_000;

    do {
      const reply = await app.inject({ method: 'GET', url, headers });

      assert.equal(reply.statusCode, 200, reply.body);
      if (predicate(reply.json())) {
        return reply.json();
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    } while (Date.now() < deadline);

    throw new Error('Прогон не достиг ожидаемого состояния. Запущено веток ' + entered.size);
  };

  try {
    const start = await app.inject({
      method: 'POST', url: prefix + '/runs', headers,
      payload: {
        id, templateId: template.id, expectedRevision: template.revision,
        modelRef: { provider: 'claude', model: 'fake' },
        files: [{ name: 'seed.txt', text: 'Синтетический рынок' }],
      },
    });

    assert.equal(start.statusCode, 202, start.body);
    const live = await waitForRun(() => entered.size === 50);

    assert.equal(live.nodes.filter((node: { status: string }) => node.status === 'running').length, 51);
  } finally {
    release.resolve();
  }
  await waitForRun((graph) => graph.status === 'done');
  const result = await app.inject({ method: 'GET', url: url + '/result', headers });

  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().rows.length, 50);
  assert.equal(result.json().incomplete, false);
});

test('стартовый запрос переживает потерю ответа после commit', async (t) => {
  const { app, headers, config } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const templates = (await app.inject({ method: 'GET', url: prefix + '/templates', headers })).json();
  const template = templates.templates.find((item: { id: string }) => item.id === 'builtin-documents');
  const payload = {
    id: 'b1690525-b349-422c-a165-778def939e5c',
    templateId: template.id, expectedRevision: template.revision,
    modelRef: { provider: 'claude', model: 'fake' },
    files: [{ name: 'a.md', text: '# A\nодин' }],
  };
  const first = await app.inject({ method: 'POST', url: prefix + '/runs', headers, payload });
  assert.equal(first.statusCode, 202);
  const check = await graphCommand(config, 'start-check', payload) as { found: boolean; revision: number };
  assert.equal(check.found, true);
  const replay = await app.inject({ method: 'POST', url: prefix + '/runs', headers, payload });
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().revision, first.json().revision);
});
test('production-каталог скрывает nonChat и принимает рабочую модель', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'grigdesk-graph-catalog-')));
  const app = fastify({ bodyLimit: 64 * 1024 ** 2, maxParamLength: INBOX_REF_LIMITS.encodedChars });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const auth = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });
  const token = auth.createSession().id;
  await app.register(authPlugin, { authStore: auth, internalToken: 'test-internal' });
  await mkdir(path.join(root, 'sse'), { recursive: true });
  await app.register(ssePlugin, { stateDir: path.join(root, 'sse') });
  const config = {
    rootDir: process.cwd(),
    factoryControlDir: path.join(root, 'control'),
    factoryBin,
    modelsPath: path.join(root, 'models.json'),
  };
  const executor = {
    graphModelProcess: true,
    untrustedInput: { text: true },
    runUntrusted: async () => ({ reply: '{"rows":[]}' }),
  };
  await app.register(graphWorkflows, {
    config,
    modelCatalog: createGraphModelCatalog(config, {
      registry: async () => ({
        claude: [
          { id: 'fake', name: 'Рабочая' },
          { id: 'hidden', name: 'Скрытая', nonChat: true },
        ],
      }),
      executorResolver: async () => executor,
    }),
    runModel: async () => ({ rows: [] }),
    autoWork: false,
  });
  const headers = { cookie: 'grigdesk_sid=' + token };
  const models = await app.inject({ method: 'GET', url: '/api/graph-workflows/models', headers });
  assert.equal(models.statusCode, 200);
  assert.deepEqual(models.json().models, [{ provider: 'claude', model: 'fake', label: 'Рабочая' }]);

  const templates = (await app.inject({ method: 'GET', url: '/api/graph-workflows/templates', headers })).json();
  const template = templates.templates.find((item: { id: string }) => item.id === 'builtin-documents');
  const base = {
    templateId: template.id, expectedRevision: template.revision,
    files: [{ name: 'a.md', text: '# A\nодин' }],
  };
  const hidden = await app.inject({
    method: 'POST', url: '/api/graph-workflows/runs', headers,
    payload: { ...base, id: '5f820c44-a351-4932-949c-4b970e81dbc8', modelRef: { provider: 'claude', model: 'hidden' } },
  });
  assert.equal(hidden.statusCode, 422);
  assert.equal(hidden.json().error, 'model_unavailable');
  const working = await app.inject({
    method: 'POST', url: '/api/graph-workflows/runs', headers,
    payload: { ...base, id: 'd11dce6a-b7cc-4654-96b4-3ea48ed46a81', modelRef: { provider: 'claude', model: 'fake' } },
  });
  assert.equal(working.statusCode, 202);
});

test('сохранение ветки влияет на следующий запуск, а не на принятый снимок', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const templateId = 'a2372fd2-e591-41c8-964a-64d321e3c677';
  const firstId = '74906bac-48d5-40ce-a6a9-96cbce242146';
  const secondId = 'b1690525-b349-422c-a165-778def939e5c';
  const baseSteps = [{ id: 'source', title: 'Источник', kind: 'input' }];
  const save = (expectedRevision: string | null, steps: unknown[], returns: string[]) => app.inject({
    method: 'POST', url: prefix + '/templates/save', headers,
    payload: { id: templateId, expectedRevision, document: { title: 'Граф', inputKind: 'documents',
      scope: { steps, returns } } },
  });

  const first = await save(null, baseSteps, ['source']);
  assert.equal(first.statusCode, 200);
  const start = (id: string, expectedRevision: string) => app.inject({
    method: 'POST', url: prefix + '/runs', headers,
    payload: { id, templateId, expectedRevision, modelRef: { provider: 'claude', model: 'fake' },
      files: [{ name: 'source.txt', text: 'Вход' }] },
  });
  const read = (id: string) => app.inject({ method: 'GET', url: prefix + '/runs/' + id, headers });

  assert.equal((await start(firstId, first.json().revision)).statusCode, 202);
  const before = (await read(firstId)).json();
  const added = { id: 'after', title: 'Сборка', kind: 'join', needs: ['source'], mode: 'all' };
  const second = await save(first.json().revision, [...baseSteps, added], ['after']);
  assert.equal(second.statusCode, 200);
  assert.equal((await start(secondId, second.json().revision)).statusCode, 202);
  assert.deepEqual((await read(firstId)).json(), before);
  assert.equal((await read(secondId)).json().nodes.some((node: { id: string }) => node.id === 'after'), true);
});

test('этап A у ворот сохраняет байты после редакции B', async (t) => {
  const { app, headers, root } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const templateId = 'a2372fd2-e591-41c8-964a-64d321e3c677';
  const firstId = '74906bac-48d5-40ce-a6a9-96cbce242146';
  const secondId = 'b1690525-b349-422c-a165-778def939e5c';
  const baseSteps = [
    { id: 'source', title: 'Источник', kind: 'input' },
    { id: 'review', title: 'Ворота', kind: 'approval', needs: ['source'] },
  ];
  const save = (expectedRevision: string | null, steps: unknown[], returns: string[]) => app.inject({
    method: 'POST', url: prefix + '/templates/save', headers,
    payload: { id: templateId, expectedRevision, document: { title: 'Граф', inputKind: 'documents',
      scope: { steps, returns } } },
  });
  const start = (id: string, expectedRevision: string) => app.inject({
    method: 'POST', url: prefix + '/runs', headers,
    payload: { id, templateId, expectedRevision, modelRef: { provider: 'claude', model: 'fake' },
      files: [{ name: 'source.txt', text: 'Вход' }] },
  });

  const first = await save(null, baseSteps, ['review']);
  assert.equal((await start(firstId, first.json().revision)).statusCode, 202);
  const runPath = path.join(root, 'control', 'graph-workflows', 'runs', firstId + '.json');
  const bytesBefore = await readFile(runPath);
  const added = { id: 'tail', title: 'Хвост', kind: 'join', needs: ['review'], mode: 'all' };
  const second = await save(first.json().revision, [...baseSteps, added], ['tail']);
  assert.equal(second.statusCode, 200);
  const bytesAfter = await readFile(runPath);
  assert.deepEqual(bytesAfter, bytesBefore);

  const node = await app.inject({ method: 'GET', url: prefix + '/runs/' + firstId + '/nodes/review', headers });
  assert.equal(node.statusCode, 200);
  assert.equal(node.json().status, 'waiting');
  const graph = (await app.inject({ method: 'GET', url: prefix + '/runs/' + firstId, headers })).json();
  assert.equal(graph.nodes.some((item: { id: string }) => item.id === 'tail'), false);
  assert.equal((await start(secondId, second.json().revision)).statusCode, 202);
  const secondGraph = (await app.inject({ method: 'GET', url: prefix + '/runs/' + secondId, headers })).json();
  assert.equal(secondGraph.nodes.some((item: { id: string }) => item.id === 'tail'), true);
});

test('встреча отдаёт протокол и поручения только после принятия того же снимка', async (t) => {
  const { app, headers, config } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const id = '5f820c44-a351-4932-949c-4b970e81dbc8';
  const templates = (await app.inject({ method: 'GET', url: prefix + '/templates', headers })).json();
  const template = templates.templates.find((item: { id: string }) => item.id === 'builtin-meeting');
  assert.ok(template);
  const response = await app.inject({
    method: 'POST', url: prefix + '/runs', headers,
    payload: {
      id, templateId: template.id, expectedRevision: template.revision,
      modelRef: { provider: 'claude', model: 'fake' },
      files: [{ name: 'meeting.json', text: JSON.stringify([
        { start: 12, end: 13, text: 'Утвердили порядок' },
        { start: 15, end: 16, text: 'Ира подготовит сводку' },
      ]) }],
    },
  });
  assert.equal(response.statusCode, 202);
  const claim = () => graphCommand(config, 'claim', {}) as Promise<ClaimFixture>;
  const finish = (j: NonNullable<ClaimFixture['job']>, key: string, title: string, rowIndex = 0) => graphCommand(config, 'settle', {
    id: j.id, nodeId: j.nodeId, generation: j.generation, claimId: j.claimId,
    rows: [{ key, title, text: title, sources: j.rows[rowIndex]?.sources ?? [] }],
  });
  const one = (await claim()).job;
  const two = (await claim()).job;
  const jobs = new Map([one, two].map((job) => [job!.nodeId, job!]));

  assert.deepEqual([...jobs.keys()].sort(), ['decisions', 'drafts']);
  await finish(jobs.get('drafts')!, 'task', 'Подготовить сводку', 1);
  await finish(jobs.get('decisions')!, 'decision', 'Утвердили порядок');

  const refine = (await claim()).job;
  assert.equal(refine!.nodeId, 'check.1.draft');
  await finish(refine!, 'draft', 'Черновик поручения');
  const url = prefix + '/runs/' + id;
  const waiting = (await app.inject({ method: 'GET', url, headers })).json();
  const preview = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();

  assert.equal(waiting.status, 'waiting');
  assert.equal(preview.approvals.find((item: { nodeId: string }) => item.nodeId === 'review').state, 'pending');
  assert.deepEqual(preview.rows.map((row: { title: string }) => row.title).sort(),
    ['Утвердили порядок', 'Черновик поручения'].sort());

  const approve = () => app.inject({ method: 'POST', url: url + '/action', headers,
    payload: { nodeId: 'review', action: 'approve', generation: 1, expectedRevision: waiting.revision } });

  assert.equal((await approve()).statusCode, 200);
  assert.equal((await approve()).statusCode, 409);

  const result = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();
  assert.equal(result.approvals.find((item: { nodeId: string }) => item.nodeId === 'review').state, 'approved');
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.missing, []);
  const sourcesByTitle = Object.fromEntries(result.rows.map((row: WorkflowRow) => [row.title, row.sources]));

  assert.deepEqual(sourcesByTitle, {
    'Утвердили порядок': [{ inputKey: 'file-1', line: 1, timeMs: 12_000 }],
    'Черновик поручения': [{ inputKey: 'file-1', line: 2, timeMs: 15_000 }],
  });
  assert.deepEqual(Object.fromEntries(preview.rows.map((row: WorkflowRow) => [row.title, row.sources])), sourcesByTitle);
  assert.equal((await app.inject({ method: 'GET', url, headers })).json().status, 'done');

  const node = (await app.inject({ method: 'GET', url: url + '/nodes/review', headers })).json();
  assert.deepEqual(node.rows.map((row: WorkflowRow) => row.title).sort(), ['Утвердили порядок', 'Черновик поручения'].sort());
  const input = (await app.inject({ method: 'GET', url: url + '/inputs/file-1', headers })).json();
  assert.equal(input.segments.length, 2);
  assert.deepEqual(input.segments.map((segment: { line: number }) => segment.line), [1, 2]);
});

test('документы переживают отказ ветки, повтор и перезапуск с тем же root', async (t) => {
  const barriers = new Map<string, { promise: Promise<{ rows: WorkflowRow[] } | { errorCode: string }>; resolve: (value: { rows: WorkflowRow[] } | { errorCode: string }) => void }>();
  const barrier = (key: string) => {
    let entry = barriers.get(key);

    if (!entry) {
      let resolve!: (value: { rows: WorkflowRow[] } | { errorCode: string }) => void;
      const promise = new Promise<{ rows: WorkflowRow[] } | { errorCode: string }>((res) => {
        resolve = res;
      });

      entry = { promise, resolve };
      barriers.set(key, entry);
    }
    return entry;
  };

  for (const key of ['files.1.parts.1.summary:1', 'files.1.parts.2.summary:1', 'files.2.parts.1.summary:1', 'files.1.parts.1.summary:2']) {
    barrier(key);
  }
  const runModel = (job: { nodeId: string; generation: number; rows: WorkflowRow[] }) => {
    return barrier(job.nodeId + ':' + job.generation).promise;
  };
  const { app, headers, root } = await testGraphApp(t, { autoWork: true, runModel: runModel as never });
  const prefix = '/api/graph-workflows';
  const templates = (await app.inject({ method: 'GET', url: prefix + '/templates', headers })).json();
  const template = templates.templates.find((item: { id: string }) => item.id === 'builtin-documents');
  const payload = {
    id: 'd11dce6a-b7cc-4654-96b4-3ea48ed46a81',
    templateId: template.id, expectedRevision: template.revision,
    modelRef: { provider: 'claude', model: 'fake' },
    files: [
      { name: 'notes.md', text: '# A\nпервый\n# B\nвторой' },
      { name: 'notes.md', text: 'абзац C' },
    ],
  };
  const url = prefix + '/runs/' + payload.id;

  assert.equal((await app.inject({ method: 'POST', url: prefix + '/runs', headers, payload })).statusCode, 202);
  const waitFor = async (predicate: (graph: {
    status: string;
    revision: number;
    nodes: { id: string; status: string; generation: number; kind: string }[];
  }) => boolean): Promise<{
    status: string;
    revision: number;
    nodes: { id: string; status: string; generation: number; kind: string }[];
  }> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const graph = (await app.inject({ method: 'GET', url, headers })).json();

      if (predicate(graph)) {
        return graph;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('состояние не достигнуто');
  };
  const running = await waitFor((graph) => graph.nodes.filter((node) => node.kind === 'agent' && node.status === 'running').length === 3);

  assert.equal(running.nodes.filter((node) => node.kind === 'agent' && node.status === 'running').length, 3);
  barriers.get('files.1.parts.1.summary:1')!.resolve({ errorCode: 'run_failed' });
  barriers.get('files.1.parts.2.summary:1')!.resolve({ rows: [{ key: 'row-1', title: 'B', text: 'готово B', sources: [{ inputKey: 'file-1', line: 3 }] }] });
  const partial = await waitFor((graph) => graph.nodes.some((node) => node.id === 'files.1.parts.1.summary' && node.status === 'failed'));
  const partialResult = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();

  assert.ok(partialResult.missing.some((item: { nodeId: string }) => item.nodeId === 'files.1.parts.1.summary'));
  assert.ok(partialResult.rows.some((row: WorkflowRow) => row.title === 'B'));
  const failed = partial.nodes.find((node) => node.id === 'files.1.parts.1.summary')!;

  barriers.get('files.1.parts.1.summary:2')!.resolve({ rows: [{ key: 'row-1', title: 'A', text: 'готово A', sources: [{ inputKey: 'file-1', line: 1 }] }] });
  assert.equal((await app.inject({
    method: 'POST', url: url + '/action', headers,
    payload: { nodeId: failed.id, generation: failed.generation, action: 'retry', expectedRevision: partial.revision },
  })).statusCode, 200);
  barriers.get('files.2.parts.1.summary:1')!.resolve({ rows: [{ key: 'row-1', title: 'C', text: 'готово C', sources: [{ inputKey: 'file-2', line: 1 }] }] });
  await waitFor((graph) => graph.status === 'done');
  const done = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();

  assert.equal(done.rows.length, 3);
  assert.deepEqual(done.missing, []);
  await app.close();
  const reopened = await openGraphTestApp(t, root, { autoWork: true, runModel: runModel as never });
  const cold = (await reopened.app.inject({ method: 'GET', url: url + '/result', headers: reopened.headers })).json();

  assert.equal(cold.rows.length, 3);
  const byTitle = Object.fromEntries(cold.rows.map((row: WorkflowRow) => [row.title, row.sources]));

  assert.deepEqual(byTitle['A'], [{ inputKey: 'file-1', line: 1 }]);
  assert.deepEqual(byTitle['C'], [{ inputKey: 'file-2', line: 1 }]);
  const beforeReplay = (await reopened.app.inject({ method: 'GET', url, headers: reopened.headers })).json();
  const replay = await reopened.app.inject({ method: 'POST', url: prefix + '/runs', headers: reopened.headers, payload });

  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().revision, beforeReplay.revision);
});

test('часть готовых документов читается до общей сборки', async (t) => {
  const { app, headers, config, root } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const templates = (await app.inject({ method: 'GET', url: prefix + '/templates', headers })).json();
  const template = templates.templates.find((item: { id: string }) => item.id === 'builtin-documents');
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';

  await app.inject({
    method: 'POST', url: prefix + '/runs', headers,
    payload: {
      id, templateId: template.id, expectedRevision: template.revision,
      modelRef: { provider: 'claude', model: 'fake' },
      files: [{ name: 'notes.md', text: '# A\nпервый' }, { name: 'notes.md', text: '# B\nвторой' }],
    },
  });
  const url = prefix + '/runs/' + id;
  const claim = () => graphCommand(config, 'claim', {}) as Promise<ClaimFixture>;
  const one = (await claim()).job!;
  const two = (await claim()).job!;

  await graphCommand(config, 'settle', {
    id, nodeId: one.nodeId, generation: 1, claimId: one.claimId,
    rows: [{ key: 'row-1', title: 'Первый', text: 'готово 1', sources: one.rows[0]!.sources }],
  });
  const partial = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();

  assert.equal(partial.incomplete, true);
  assert.ok(partial.rows.some((row: WorkflowRow) => row.title === 'Первый'));
  await graphCommand(config, 'settle', {
    id, nodeId: two.nodeId, generation: 1, claimId: two.claimId, errorCode: 'run_failed',
  });
  const failed = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();

  assert.ok(failed.rows.some((row: WorkflowRow) => row.title === 'Первый'));
  assert.ok(failed.missing.length > 0);
  const inputOne = (await app.inject({ method: 'GET', url: url + '/inputs/file-1', headers })).json();
  const inputTwo = (await app.inject({ method: 'GET', url: url + '/inputs/file-2', headers })).json();

  assert.notEqual(inputOne.text, inputTwo.text);
  await app.close();
  const reopened = await openGraphTestApp(t, root);
  const coldOne = (await reopened.app.inject({ method: 'GET', url: url + '/inputs/file-1', headers: reopened.headers })).json();
  const coldTwo = (await reopened.app.inject({ method: 'GET', url: url + '/inputs/file-2', headers: reopened.headers })).json();

  assert.equal(coldOne.text, inputOne.text);
  assert.equal(coldTwo.text, inputTwo.text);
  const graph = (await reopened.app.inject({ method: 'GET', url, headers: reopened.headers })).json();
  const failedNode = graph.nodes.find((node: { id: string }) => node.id === two.nodeId);

  await reopened.app.inject({
    method: 'POST', url: url + '/action', headers: reopened.headers,
    payload: { nodeId: two.nodeId, generation: failedNode.generation, action: 'retry', expectedRevision: graph.revision },
  });
  const retryClaim = (await graphCommand(reopened.config, 'claim', {}) as ClaimFixture).job!;

  assert.equal(retryClaim.nodeId, two.nodeId);
  assert.equal(retryClaim.generation, 2);
  await graphCommand(reopened.config, 'settle', {
    id, nodeId: two.nodeId, generation: 2, claimId: retryClaim.claimId,
    rows: [{ key: 'row-1', title: 'Второй', text: 'готово 2', sources: retryClaim.rows[0]!.sources }],
  });
  const done = (await reopened.app.inject({ method: 'GET', url: url + '/result', headers: reopened.headers })).json();

  assert.equal(done.rows.length, 2);
  assert.deepEqual(done.missing, []);
});

test('выбранные ворота показывают свою выборку', async (t) => {
  const { app, headers, config } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const templateId = 'a2372fd2-e591-41c8-964a-64d321e3c677';
  const document = {
    title: 'Двое ворот', inputKind: 'documents',
    scope: {
      returns: ['gate-a', 'gate-b'],
      steps: [
        { id: 'src', title: 'Источник', kind: 'input' },
        { id: 'a', title: 'A', kind: 'agent', needs: ['src'], prompt: 'a' },
        { id: 'b', title: 'B', kind: 'agent', needs: ['src'], prompt: 'b' },
        { id: 'gate-a', title: 'Ворота A', kind: 'approval', needs: ['a'] },
        { id: 'gate-b', title: 'Ворота B', kind: 'approval', needs: ['b'] },
      ],
    },
  };
  const save = await app.inject({ method: 'POST', url: prefix + '/templates/save', headers,
    payload: { id: templateId, expectedRevision: null, document } });
  const id = 'b1690525-b349-422c-a165-778def939e5c';

  await app.inject({
    method: 'POST', url: prefix + '/runs', headers,
    payload: { id, templateId, expectedRevision: save.json().revision,
      modelRef: { provider: 'claude', model: 'fake' }, files: [{ name: 'a.txt', text: 'вход' }] },
  });
  const url = prefix + '/runs/' + id;
  const claim = () => graphCommand(config, 'claim', {}) as Promise<ClaimFixture>;
  const jobA = (await claim()).job!;
  const jobB = (await claim()).job!;

  await graphCommand(config, 'settle', { id, nodeId: jobA.nodeId, generation: 1, claimId: jobA.claimId,
    rows: [{ key: 'row-1', title: 'Строка A', text: 'A', sources: jobA.rows[0]!.sources }] });
  await graphCommand(config, 'settle', { id, nodeId: jobB.nodeId, generation: 1, claimId: jobB.claimId,
    rows: [{ key: 'row-1', title: 'Строка B', text: 'B', sources: jobB.rows[0]!.sources }] });
  const nodeA = (await app.inject({ method: 'GET', url: url + '/nodes/gate-a', headers })).json();
  const nodeB = (await app.inject({ method: 'GET', url: url + '/nodes/gate-b', headers })).json();

  assert.deepEqual(nodeA.rows.map((row: WorkflowRow) => row.title), ['Строка A']);
  assert.deepEqual(nodeB.rows.map((row: WorkflowRow) => row.title), ['Строка B']);
  const summary = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();

  assert.deepEqual(summary.approvals.map((item: { nodeId: string }) => item.nodeId).sort(), ['gate-a', 'gate-b']);
  const stale = await app.inject({ method: 'POST', url: url + '/action', headers,
    payload: { nodeId: 'gate-a', action: 'approve', generation: 1, expectedRevision: nodeA.revision - 1 } });

  assert.equal(stale.statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: url + '/action', headers,
    payload: { nodeId: 'gate-b', action: 'approve', generation: 1, expectedRevision: nodeB.revision } })).statusCode, 200);
  const afterB = (await app.inject({ method: 'GET', url, headers })).json();
  const gateA = afterB.nodes.find((node: { id: string }) => node.id === 'gate-a');

  assert.equal(gateA.status, 'waiting');
  assert.equal((await app.inject({ method: 'POST', url: url + '/action', headers,
    payload: { nodeId: 'gate-a', action: 'approve', generation: 1, expectedRevision: afterB.revision } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url, headers })).json().status, 'done');
});

test('заголовки остаются читаемыми поверх большого каталога', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const steps = Array.from({ length: 13 }, (_, index) => ({
    id: 'step-' + (index + 1), title: 'Шаг ' + (index + 1), kind: 'agent',
    needs: index ? ['step-' + index] : [], prompt: 'инструкция '.repeat(350),
  }));
  const document = { title: 'Большой', inputKind: 'documents', scope: { returns: ['step-13'], steps } };

  for (let index = 0; index < 31; index += 1) {
    const save = await app.inject({ method: 'POST', url: prefix + '/templates/save', headers,
      payload: { id: crypto.randomUUID(), expectedRevision: null, document: { ...document, title: 'Большой ' + index } } });

    assert.equal(save.statusCode, 200);
  }
  const first = (await app.inject({ method: 'GET', url: prefix + '/templates', headers })).json();

  assert.equal(first.templates.length, 30);
  assert.ok(first.nextCursor);
  assert.ok(!JSON.stringify(first).includes('инструкция'));
  const second = (await app.inject({ method: 'GET', url: prefix + '/templates?cursor=' + encodeURIComponent(first.nextCursor), headers })).json();

  assert.equal(second.templates.length, 3);
  const picked = second.templates[0];
  const full = (await app.inject({ method: 'GET', url: prefix + '/templates/' + picked.id, headers })).json();

  assert.equal(full.document.scope.steps.length, 13);
});

test('общая сводка и выбранные ворота читают одни данные', async (t) => {
  const { app, headers, config } = await testGraphApp(t);
  const prefix = '/api/graph-workflows';
  const templateId = 'a2372fd2-e591-41c8-964a-64d321e3c677';
  let revision: string | null = null;

  for (const reads of [['normalized'], []]) {
    const document = {
      title: 'Чтение', inputKind: 'documents',
      scope: {
        returns: ['review'],
        steps: [
          { id: 'raw', title: 'Сырьё', kind: 'input' },
          { id: 'normalized', title: 'Норма', kind: 'agent', needs: ['raw'], prompt: 'нормализуй' },
          { id: 'review', title: 'Ворота', kind: 'approval', needs: ['raw', 'normalized'], reads },
        ],
      },
    };
    const save: { statusCode: number; json: () => { revision: string } } = await app.inject({
      method: 'POST', url: prefix + '/templates/save', headers,
      payload: { id: templateId, expectedRevision: revision, document },
    });

    assert.equal(save.statusCode, 200);
    revision = save.json().revision;
    const id = crypto.randomUUID();

    await app.inject({
      method: 'POST', url: prefix + '/runs', headers,
      payload: { id, templateId, expectedRevision: save.json().revision,
        modelRef: { provider: 'claude', model: 'fake' }, files: [{ name: 'a.txt', text: 'сырьё' }] },
    });
    const url = prefix + '/runs/' + id;
    const job = (await graphCommand(config, 'claim', {}) as ClaimFixture).job!;

    await graphCommand(config, 'settle', { id, nodeId: 'normalized', generation: 1, claimId: job.claimId,
      rows: [{ key: 'row-1', title: 'Норма', text: 'нормализовано', sources: job.rows[0]!.sources }] });
    const summary = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();
    const node = (await app.inject({ method: 'GET', url: url + '/nodes/review', headers })).json();

    assert.deepEqual(node.rows, summary.rows);
    if (reads.length) {
      assert.deepEqual(node.rows.map((row: WorkflowRow) => row.title), ['Норма']);
    } else {
      assert.deepEqual(node.rows, []);
    }
    const graph = (await app.inject({ method: 'GET', url, headers })).json();

    await app.inject({ method: 'POST', url: url + '/action', headers,
      payload: { nodeId: 'review', action: 'approve', generation: 1, expectedRevision: graph.revision } });
    const approved = (await app.inject({ method: 'GET', url: url + '/result', headers })).json();

    assert.deepEqual(approved.rows, node.rows);
  }
});

test('ворота показывают три TXT по 50 КиБ, итог отдаёт все страницы', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const route = '/api/graph-workflows';
  const templateId = '5f820c44-a351-4932-949c-4b970e81dbc8';
  const saved = await app.inject({
    method: 'POST', url: route + '/templates/save', headers,
    payload: {
      id: templateId, expectedRevision: null,
      document: {
        title: 'Документы на проверку', inputKind: 'documents',
        scope: {
          steps: [
            { id: 'source', title: 'Вход', kind: 'input' },
            { id: 'gate', title: 'Утверждение', kind: 'approval', needs: ['source'] },
          ],
          returns: ['gate'],
        },
      },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const start = (id: string, files: { name: string; text: string }[]) => app.inject({
    method: 'POST', url: route + '/runs', headers,
    payload: {
      id, templateId, expectedRevision: saved.json().revision,
      modelRef: { provider: '', model: '' }, files,
    },
  });
  const files = ['A', 'B', 'C'].map((letter) => ({ name: letter + '.txt', text: letter.repeat(50 * 1024) }));
  const id = 'b1690525-b349-422c-a165-778def939e5c';
  const base = route + '/runs/' + id;

  assert.equal((await start(id, files)).statusCode, 202);
  const gate = (await app.inject({ url: base + '/nodes/gate', headers })).json();
  assert.equal(gate.approval.reviewActions.approve, true);
  assert.deepEqual(gate.rows.map((row: WorkflowRow) => row.text.length), [51200, 51200, 51200]);

  const response = await app.inject({
    method: 'POST', url: base + '/action', headers,
    payload: { nodeId: 'gate', action: 'approve', expectedRevision: gate.revision, generation: gate.generation },
  });
  assert.equal(response.statusCode, 200, response.body);

  let cursor: string | null = null;
  const observed: string[] = [];

  do {
    const suffix = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
    const page = await app.inject({ url: base + '/result' + suffix, headers });

    assert.equal(page.statusCode, 200, page.body);
    const result = page.json();
    assert.equal(result.incomplete, false);
    observed.push(...result.rows.map((row: WorkflowRow) => row.text));
    cursor = result.nextCursor;
  } while (cursor);

  assert.deepEqual(observed.map((text) => [text[0], text.length]), [['A', 51200], ['B', 51200], ['C', 51200]]);

  const oversized = '74906bac-48d5-40ce-a6a9-96cbce242146';
  assert.equal((await start(oversized, files.map((file) => ({
    ...file, text: '<'.repeat(50 * 1024),
  })))).statusCode, 202);
  const bad = route + '/runs/' + oversized;
  const blocked = (await app.inject({ url: bad + '/nodes/gate', headers })).json();

  assert.equal(blocked.errorCode, 'output_limit');
  assert.equal(blocked.approval, undefined);
  const denied = await app.inject({
    method: 'POST', url: bad + '/action', headers,
    payload: { nodeId: 'gate', action: 'approve', expectedRevision: blocked.revision, generation: blocked.generation },
  });
  assert.equal(denied.statusCode, 422);
  assert.equal((await app.inject({ url: bad + '/result', headers })).json().incomplete, true);
});

test('возврат использует ID экземпляра внутри двух соседних подмаршрутов', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const route = '/api/graph-workflows';
  const templateId = '5f820c44-a351-4932-949c-4b970e81dbc8';
  const saved = await app.inject({
    method: 'POST', url: route + '/templates/save', headers,
    payload: {
      id: templateId, expectedRevision: null,
      document: {
        title: 'Независимые ворота', inputKind: 'documents',
        scope: {
          steps: [
            { id: 'batch', title: 'Вход', kind: 'input' },
            {
              id: 'part', title: 'По файлам', kind: 'forEach', needs: ['batch'], source: 'batch',
              scope: {
                steps: [
                  { id: 'source', title: 'Документ', kind: 'input', reads: ['$item'] },
                  { id: 'gate', title: 'Ворота', kind: 'approval', needs: ['source'], retryFrom: ['source'] },
                ],
                returns: ['gate'],
              },
            },
          ],
          returns: ['part'],
        },
      },
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';
  const started = await app.inject({
    method: 'POST', url: route + '/runs', headers,
    payload: {
      id, templateId, expectedRevision: saved.json().revision, modelRef: { provider: '', model: '' },
      files: [{ name: 'a.txt', text: 'первый' }, { name: 'b.txt', text: 'второй' }],
    },
  });
  assert.equal(started.statusCode, 202, started.body);

  const base = route + '/runs/' + id;
  const first = (await app.inject({ url: base + '/nodes/part.1.gate', headers })).json();
  const target = first.approval.reviewActions.targets[0].id;

  assert.equal(target, 'part.1.source');
  const rejected = await app.inject({
    method: 'POST', url: base + '/action', headers,
    payload: {
      action: 'reject', nodeId: 'part.1.gate', generation: first.generation, expectedRevision: first.revision,
      target, comment: 'Уточнить первый документ',
    },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  const newFirst = (await app.inject({ url: base + '/nodes/part.1.gate', headers })).json();
  const second = (await app.inject({ url: base + '/nodes/part.2.gate', headers })).json();

  assert.equal(newFirst.generation, first.generation + 1);
  assert.equal(second.generation, first.generation);
  assert.equal(second.approval.reviewActions.targets[0].id, 'part.2.source');
});

test('отказ без цели закрывает прогон с готовой модельной веткой', async (t) => {
  const { app, headers, config } = await testGraphApp(t);
  const templateId = '5f820c44-a351-4932-949c-4b970e81dbc8';
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';
  const saved = await graphCommand(config, 'template-save', {
    id: templateId, expectedRevision: null,
    document: {
      title: 'Отказ', inputKind: 'documents',
      scope: {
        steps: [
          { id: 'src', title: 'Вход', kind: 'input' },
          { id: 'model', title: 'Модель', kind: 'agent', needs: ['src'], prompt: 'Проверка' },
          { id: 'gate', title: 'Решение', kind: 'approval', needs: ['src'] },
        ],
        returns: ['gate', 'model'],
      },
    },
  }) as { revision: string };
  await graphCommand(config, 'start', {
    id, templateId, expectedRevision: saved.revision, modelRef: { provider: 'claude', model: 'fake' },
    files: [{ name: 'a.txt', text: 'Синтетический вход' }],
  });
  const url = '/api/graph-workflows/runs/' + id;
  const gate = (await app.inject({ url: url + '/nodes/gate', headers })).json();
  const rejected = await app.inject({
    method: 'POST', url: url + '/action', headers,
    payload: {
      action: 'reject', nodeId: 'gate', generation: gate.generation,
      expectedRevision: gate.revision, comment: 'Отклонено',
    },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal((await app.inject({ url, headers })).json().status, 'rejected');
  assert.equal((await graphCommand(config, 'claim', {}) as ClaimFixture).job, null);
});

test('Windows отклоняет модельный маршрут до создания записи, локальный допускает', async (t) => {
  const { app, headers } = await testGraphApp(t);
  const route = '/api/graph-workflows';
  const templateId = '5f820c44-a351-4932-949c-4b970e81dbc8';
  const saved = await app.inject({
    method: 'POST', url: route + '/templates/save', headers,
    payload: {
      id: templateId, expectedRevision: null,
      document: {
        title: 'Локальный граф', inputKind: 'documents',
        scope: { steps: [{ id: 'src', title: 'Вход', kind: 'input' }], returns: ['src'] },
      },
    },
  });
  const templates = (await app.inject({ url: route + '/templates', headers })).json().templates;
  const builtin = templates.find((item: { id: string }) => item.id === 'builtin-documents');
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';
  const post = (selected: string, expectedRevision: string) => app.inject({
    method: 'POST', url: route + '/runs', headers,
    payload: {
      id, templateId: selected, expectedRevision, modelRef: { provider: '', model: '' },
      files: [{ name: 'a.txt', text: 'Вход' }],
    },
  });

  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const denied = await post(builtin.id, builtin.revision);
    assert.equal(denied.statusCode, 422, denied.body);
    assert.equal(denied.json().error, 'workflow_model_unsupported');
    assert.equal((await app.inject({ url: route + '/runs/' + id, headers })).statusCode, 404);
    assert.equal((await post(templateId, saved.json().revision)).statusCode, 202);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
