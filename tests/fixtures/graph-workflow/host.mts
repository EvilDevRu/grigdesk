// Общий хост графовых тестов: inject-фикстура и loopback-стенд для браузерной приёмки.
// Запуск: node tests/fixtures/graph-workflow/host.mts --serve — печатает ровно loopback порт.
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthStore } from '../../../server/src/lib/authStore.ts';
import { writeWindowKey } from '../../../server/src/lib/windowKey.ts';
import { INBOX_REF_LIMITS } from '../../../server/src/lib/inbox/identity.ts';
import authPlugin from '../../../server/src/plugins/auth.ts';
import ssePlugin from '../../../server/src/plugins/sse.ts';
import apiVersionPlugin from '../../../server/src/plugins/apiVersion.ts';
import authModule from '../../../server/src/modules/auth/index.ts';
import graphWorkflows from '../../../server/src/modules/graphWorkflows/index.ts';
import type { GraphClaimJob } from '../../../server/src/modules/graphWorkflows/index.ts';
import type { GraphModelResult } from '../../../server/src/lib/graphWorkflowExecutor.ts';
import type { WorkflowRow } from '../../../shared/pipeline/graphWorkflowContracts.ts';

const requireServer = createRequire(new URL('../../../server/package.json', import.meta.url));
const fastify = requireServer('fastify');

export interface GraphFixtureOptions {
  root: string;
  factoryBin: string;
  runModel?: (job: GraphClaimJob, signal: AbortSignal) => Promise<GraphModelResult>;
  autoWork?: boolean;
  listen?: boolean;
}

export interface GraphFixture {
  app: ReturnType<typeof fastify>;
  config: { rootDir: string; factoryControlDir: string; factoryBin: string; modelsPath: string };
  headers: { cookie: string };
  token: string;
  windowAuth: { origin: string; key: string };
  root: string;
}

/**
 * Тестовый DSP model стенда: встреча получает две реплики, документный узел
 * notes.md один раз возвращает явный отказ на первой generation.
 */
async function serveModel(job: GraphClaimJob): Promise<GraphModelResult> {
  if (process.env.TEST_GRAPH_CRASH_MODEL === '1') {
    process.send?.({ type: 'model-call', nodeId: job.nodeId, generation: job.generation });
    if (job.nodeId.endsWith('left') && job.generation === 1) {
      return await new Promise<GraphModelResult>(() => {});
    }
    const title = job.nodeId.endsWith('left') ? 'Левый' : 'Правый';

    return { rows: [{ key: 'row-1', title, text: 'готово ' + title, sources: job.rows[0]?.sources ?? [] }] };
  }
  if (job.kind === 'meetingTasks') {
    const rows: WorkflowRow[] = [
      { key: 'row-1', title: 'Утвердили порядок', text: 'Утвердили порядок', sources: job.rows[0]?.sources ?? [] },
      { key: 'row-2', title: 'Ира подготовит сводку', text: 'Ира подготовит сводку', sources: job.rows[1]?.sources ?? [] },
    ];

    return { rows };
  }
  if (job.generation === 1 && job.rows.some((row) => row.title === 'notes.md')) {
    return { errorCode: 'run_failed' };
  }
  return { rows: [{ key: 'row-1', title: 'Сводка', text: 'готово', sources: job.rows[0]?.sources ?? [] }] };
}

/**
 * Создаёт приложение с настоящими auth/SSE/graph модулями над приватным root.
 * listen=false даёт app.inject; listen=true поднимает loopback и window-key.
 */
export async function createGraphFixture(opts: GraphFixtureOptions): Promise<GraphFixture> {
  const root = opts.root;
  const app = fastify({
    bodyLimit: 64 * 1024 ** 2,
    maxParamLength: INBOX_REF_LIMITS.encodedChars,
  });
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });
  const token = authStore.createSession().id;
  const windowAuth = { origin: '', key: await writeWindowKey(path.join(root, 'window-key')) };

  await app.register(apiVersionPlugin);
  await app.register(authPlugin, { authStore, internalToken: 'test-internal' });
  await app.register(authModule, { authStore, windowAuth });
  await mkdir(path.join(root, 'sse'), { recursive: true });
  await app.register(ssePlugin, { stateDir: path.join(root, 'sse') });

  const config = {
    rootDir: process.cwd(),
    factoryControlDir: path.join(root, 'control'),
    factoryBin: opts.factoryBin,
    modelsPath: path.join(root, 'models.json'),
  };

  await app.register(graphWorkflows, {
    config,
    modelCatalog: {
      list: async () => [{ provider: 'claude', model: 'fake', label: 'Тестовая модель' }],
      resolve: async (value: { provider: string; model: string }) =>
        value.provider === 'claude' && value.model === 'fake' ? value : null,
    },
    runModel: opts.runModel ?? serveModel,
    autoWork: opts.autoWork ?? false,
  });

  if (opts.listen) {
    app.get('/api/projects', async () => ({ projects: [] }));
    app.get('/api/tasks', async () => ({
      tasks: [{ id: 42, title: 'Legacy задача', status: 'in_progress', source: 'factory' }],
    }));
    app.get('/api/tasks/42/graph', async () => ({
      pos: { plan: [140, 55], gate_plan: [360, 55] },
      nodes: { plan: ['agent', 'План', ''], gate_plan: ['human', 'Ворота', ''] },
      edges: [['plan', 'gate_plan', '', 'pass', 'h']],
      statuses: { plan: 'done', gate_plan: 'wait' },
      nodeMeta: {},
      progress: { done: 1, total: 2 },
    }));
    windowAuth.origin = await app.listen({ host: '127.0.0.1', port: 0 });
  }
  return { app, config, headers: { cookie: 'grigdesk_sid=' + token }, token, windowAuth, root };
}

const isServe = process.argv.includes('--serve')
  && path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (isServe) {
  const root = await realpath(process.env.TEST_GRAPH_FIXTURE_ROOT ?? await mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-serve-')));

  await chmod(root, 0o700);
  const factoryBin = process.env.TEST_GRAPH_FACTORY_BIN;

  if (!factoryBin) {
    process.stderr.write('TEST_GRAPH_FACTORY_BIN обязателен для --serve\n');
    process.exit(1);
  }
  const fixture = await createGraphFixture({ root, factoryBin, autoWork: true, listen: true });

  process.stdout.write(fixture.windowAuth.origin + '\n');
}