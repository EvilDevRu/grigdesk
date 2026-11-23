import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { GraphWorkflowWorkers } from '../../server/src/lib/graphWorkflowWorkers.ts';
import { graphCommand, GraphCommandError, type GraphCommandConfig } from '../../server/src/lib/graphWorkflows.ts';
import {
  spawn, withExternalCliProcess, withGraphLaunch,
} from '../../server/src/lib/providerInstall/externalCliProcess.ts';
import { runCodexUntrusted } from '../../server/src/lib/executors/_codexUntrusted.ts';
import { runClaudeUntrusted } from '../../server/src/lib/executors/claude.ts';
import { helperCommandFor, type RuntimePaths } from '../../server/src/lib/runtimePaths.ts';
import { AccessProfileService } from '../../server/src/lib/accessProfiles/service.ts';
import { getExecutor, getProviderAdapters } from '../../server/src/lib/executors/index.ts';
import type { CatalogModel } from '../../server/src/lib/modelsRegistry.ts';
import { createGraphModelCatalog } from '../../server/src/lib/graphWorkflowCatalog.ts';
import { runGraphModelJob } from '../../server/src/lib/graphWorkflowModelHelper.ts';
import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { buildTestGo } from '../helpers/goBuildFixture.mts';
import type { WorkflowRow } from '../../shared/pipeline/graphWorkflowContracts.ts';

const execFileAsync = promisify(execFile);
const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const factoryBin = process.env.TEST_GRAPH_FACTORY_BIN
  ?? buildTestGo('graph-factory', ['build'], './utilities/factory/cmd/factory');

interface ClaimFixture {
  job: {
    id: string; nodeId: string; generation: number; claimId: string; expiresAt: number;
    kind: 'agent' | 'meetingTasks'; rows: WorkflowRow[];
    modelRef: { provider: string; model: string };
  } | null;
  changed: { id: string; revision?: number }[];
  pending: boolean;
}

async function clockFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-worker-'));
  const binary = path.join(root, 'factory-clock-fixture');
  const clockFile = path.join(root, 'clock');

  execFileSync('go', ['test', '-c', '-o', binary, './utilities/factory/internal/cli'], {
    cwd: repo, env: { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off' },
  });
  await writeFile(clockFile, '1000');
  const previous = process.env.GRAPH_TEST_CLOCK_FILE;

  process.env.GRAPH_TEST_CLOCK_FILE = clockFile;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.GRAPH_TEST_CLOCK_FILE;
    } else {
      process.env.GRAPH_TEST_CLOCK_FILE = previous;
    }
    await rm(root, { recursive: true, force: true });
  });
  const config: GraphCommandConfig = {
    factoryBin: binary, factoryControlDir: path.join(root, 'control'), rootDir: repo,
  };
  const setClock = (value: number) => writeFile(clockFile, String(value));

  return { root, config, setClock };
}

test('поздний успех после deadline становится interrupted без settle', async (t) => {
  const { config, setClock } = await clockFixture(t);
  const templates = await graphCommand(config, 'templates', {}) as {
    templates: { id: string; revision: string }[];
  };
  const template = templates.templates.find((item) => item.id === 'builtin-documents')!;
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';

  await graphCommand(config, 'start', {
    id, templateId: template.id, expectedRevision: template.revision,
    modelRef: { provider: 'claude', model: 'fake' },
    files: [{ name: 'a.md', text: '# A\nодин' }, { name: 'b.md', text: '# B\nдва' }],
  });
  const first = await graphCommand(config, 'claim', {}) as ClaimFixture;

  assert.ok(first.job);
  const job = first.job;
  const deadline = new AbortController();
  let resolveLate: ((value: { rows: WorkflowRow[] }) => void) | undefined;
  const late = new Promise<{ rows: WorkflowRow[] }>((resolve) => {
    resolveLate = resolve;
  });
  let settleCalls = 0;
  const announced: { id: string }[] = [];
  let fed = false;
  const workers = new GraphWorkflowWorkers({
    claim: async () => {
      if (!fed) {
        fed = true;
        return { job, changed: [], pending: true };
      }
      return { job: null, changed: [], pending: false };
    },
    settle: async () => {
      settleCalls += 1;
      return { id };
    },
    run: () => late,
    announce: (update) => announced.push(update),
    unavailable: () => {},
    invalidateRuns: () => {},
    deadlineSignal: () => deadline.signal,
  });

  workers.wake();
  await new Promise((resolve) => setTimeout(resolve, 50));
  deadline.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(announced.some((update) => update.id === id));
  assert.equal(settleCalls, 0);

  resolveLate?.({ rows: [{ key: 'late', title: 'Поздний', text: 'устарел' }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settleCalls, 0);
  await workers.close();

  await setClock(job.expiresAt + 1);
  const after = await graphCommand(config, 'claim', {}) as ClaimFixture;
  const graph = await graphCommand(config, 'read', { id }) as {
    nodes: { id: string; status: string; errorCode?: string }[];
  };
  const expired = graph.nodes.find((node) => node.id === job.nodeId);

  assert.equal(expired?.status, 'failed');
  assert.equal(expired?.errorCode, 'interrupted');
  assert.ok(after.job);
  assert.notEqual(after.job.nodeId, job.nodeId);
});

async function graphSpawnFixture(t: { after: (fn: () => Promise<void>) => void }, behaviorTemplate: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-permit-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'provider');
  const marker = path.join(root, 'marker');

  const behavior = behaviorTemplate.replaceAll('__MARKER__', JSON.stringify(marker));

  await writeFile(bin, `#!${process.execPath}\n${behavior}\n`);
  await chmod(bin, 0o755);
  await mkdir(path.join(root, 'leases'), { recursive: true });
  const context = {
    providerId: 'claude',
    executable: bin,
    resourceKey: createHash('sha256').update('graph-permit-test').digest('hex'),
    leaseDirectory: path.join(root, 'leases'),
    env: { ...process.env },
  };
  return { root, bin, marker, context };
}

test('permit задерживает провайдера до принятого допуска и сверяет PID', async (t) => {
  const { bin, marker, context } = await graphSpawnFixture(t, `
    require('node:fs').appendFileSync(__MARKER__, 'launch\\n');
  `);
  const admitted: number[] = [];
  let releaseAdmit: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseAdmit = resolve;
  });
  const child = withGraphLaunch({
    admit: async ({ pid }) => {
      admitted.push(pid);
      await gate;
    },
    stop: async () => {},
  }, () => withExternalCliProcess(context, () => spawn(bin, [], {
    cwd: process.cwd(), env: {}, stdio: ['pipe', 'pipe', 'pipe'],
  })));
  const closed = new Promise((resolve) => child.once('close', resolve));

  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(readFile(marker, 'utf8'));
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0], child.pid);
  releaseAdmit?.();
  await closed;
  assert.equal((await readFile(marker, 'utf8')).trim(), 'launch');
});

test('EOF и отказ допуска не запускают провайдера', async (t) => {
  const { bin, marker, context } = await graphSpawnFixture(t, `
    require('node:fs').appendFileSync(__MARKER__, 'launch\\n');
  `);
  const child = withGraphLaunch({
    admit: async () => {
      throw new Error('stale_claim');
    },
    stop: async () => {},
  }, () => withExternalCliProcess(context, () => spawn(bin, [], {
    cwd: process.cwd(), env: {}, stdio: ['pipe', 'pipe', 'pipe'],
  })));

  await new Promise((resolve) => child.once('close', resolve));
  await assert.rejects(readFile(marker, 'utf8'));
});

const CODEX_READY = {
  thread: { id: 'isolated', ephemeral: true, environments: [] },
  instructionSources: [],
  runtimeWorkspaceRoots: [],
  approvalPolicy: 'never',
  sandbox: { type: 'readOnly', networkAccess: false },
  model: 'test-model',
};

test('Codex graph-порт запускает CLI ровно один раз после допуска', async (t) => {
  const { bin, marker, context } = await graphSpawnFixture(t, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    fs.appendFileSync(__MARKER__, 'launch\\n');
    const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const event = JSON.parse(line);
      if (event.id === 1) send({ id: 1, result: {} });
      if (event.id === 2) send({ id: 2, result: ${JSON.stringify(CODEX_READY)} });
      if (event.id === 3) {
        send({ method: 'item/completed', params: { threadId: 'isolated',
          item: { id: 'reply', type: 'agentMessage', text: '{"rows":[]}' } } });
        send({ method: 'turn/completed', params: { threadId: 'isolated', turn: { status: 'completed' } } });
      }
    });
  `);
  const admitted: number[] = [];
  const result = await withGraphLaunch({
    admit: async ({ pid }) => {
      admitted.push(pid);
    },
    stop: async () => {},
  }, () => withExternalCliProcess(context, () => runCodexUntrusted({
    config: { codexBin: bin }, message: 'вход', model: 'test-model',
  })));

  assert.equal(result.reply, '{"rows":[]}');
  assert.equal((await readFile(marker, 'utf8')).trim(), 'launch');
  assert.equal(admitted.length, 1);
});

test('Claude graph-порт запускает CLI ровно один раз после допуска', async (t) => {
  const { bin, marker, context } = await graphSpawnFixture(t, `
    const fs = require('node:fs');
    fs.appendFileSync(__MARKER__, 'launch\\n');
    process.stdin.resume();
    process.stdout.write(JSON.stringify({
      type: 'result', result: '{"rows":[]}', is_error: false, model: 'test-model',
    }) + '\\n');
    process.exit(0);
  `);
  const admitted: number[] = [];
  const result = await withGraphLaunch({
    admit: async ({ pid }) => {
      admitted.push(pid);
    },
    stop: async () => {},
  }, () => withExternalCliProcess(context, () => runClaudeUntrusted({
    config: { claudeBin: bin }, message: 'вход', model: 'test-model',
  })));

  assert.equal(result.reply, '{"rows":[]}');
  assert.equal((await readFile(marker, 'utf8')).trim(), 'launch');
  assert.equal(admitted.length, 1);
});

test('helper --probe отвечает видом сборки без чтения job', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-helper-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await execFileAsync(process.execPath,
    [path.join(repo, 'server/src/lib/graphWorkflowModelHelper.ts'), '--probe']);

  assert.deepEqual(JSON.parse(source.stdout), { helper: 'graph-workflow-model', kind: 'source' });

  const helperDir = path.join(root, 'helpers');
  const helper = await buildHelper({
    root: repo,
    manifestPath: path.join(repo, 'server/build/helpers.json'),
    id: 'graph-workflow-model',
    outDir: helperDir,
    workDir: path.join(root, 'build'),
  });

  await writeFile(path.join(helperDir, 'helpers.json'), JSON.stringify({
    schema: 1,
    helpers: [{ id: 'graph-workflow-model', entry: 'graphWorkflowModelHelper.ts' }],
  }));
  const paths = {
    kind: 'packaged', root, node: process.execPath, helperDirectory: helperDir,
  } as unknown as RuntimePaths;
  await symlink(path.join(repo, 'server/node_modules'), path.join(root, 'node_modules'));
  const catalog = JSON.parse(await readFile(path.join(helperDir, 'helpers.json'), 'utf8'));
  const command = helperCommandFor(paths, catalog, 'graph-workflow-model', ['--probe']);

  assert.equal(command.args[0], helper.file);
  const packaged = await execFileAsync(command.command, command.args);

  assert.deepEqual(JSON.parse(packaged.stdout), { helper: 'graph-workflow-model', kind: 'packaged' });
});
test('SEA: упакованная выдача читает каталог и вызывает модель один раз с выбранным профилем', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const { root, bin, marker } = await graphSpawnFixture(t, `
    const fs = require('node:fs');
    const path = require('node:path');
    const readline = require('node:readline');
    if (process.argv.includes('--version')) {
      console.log('codex-cli 0.167.1');
      process.exit(0);
    }
    const home = process.env.CODEX_HOME;
    const account = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).account;
    const record = (type) => fs.appendFileSync(__MARKER__, JSON.stringify({ type, account, home }) + '\\n');
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const event = JSON.parse(line);
      if (event.method === 'initialize') send({ id: event.id, result: {} });
      if (event.method === 'model/list') {
        record('catalog');
        send({ id: event.id, result: { data: [{ id: 'test-model', model: 'test-model' }] } });
      }
      if (event.method === 'thread/start') send({ id: event.id, result: ${JSON.stringify(CODEX_READY)} });
      if (event.method === 'turn/start') {
        record('model');
        const text = JSON.stringify({ rows: [{ title: 'Результат', text: account, line: 1 }] });
        send({ method: 'item/completed', params: { threadId: 'isolated',
          item: { id: 'reply', type: 'agentMessage', text } } });
        send({ method: 'turn/completed', params: { threadId: 'isolated', turn: { status: 'completed' } } });
      }
    });
  `);
  const outDir = path.join(root, 'server/runtime/helpers');
  const manifestPath = path.join(repo, 'server/build/helpers.json');

  for (const id of ['graph-workflow-model', 'external-cli-lease']) {
    await buildHelper({ root: repo, id, manifestPath, outDir, workDir: path.join(root, 'build') });
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const node = path.join(root, 'runtime/node/bin/node');

  await mkdir(path.dirname(node), { recursive: true });
  await symlink(process.execPath, node);
  await symlink(path.join(repo, 'server/node_modules'), path.join(root, 'server/node_modules'));
  await writeFile(path.join(outDir, 'helpers.json'), JSON.stringify(manifest));

  const config = {
    rootDir: root, stateDir: path.join(root, 'state'), dataHome: root,
    factoryBin, factoryControlDir: path.join(root, 'control'), modelsPath: path.join(root, 'models.json'),
    artifactsDir: path.join(root, 'artifacts'), codexBin: bin,
  };
  const homeA = path.join(root, 'account-a');
  const homeB = path.join(root, 'account-b');

  for (const [directory, account] of [[homeA, 'A'], [homeB, 'B']]) {
    await mkdir(directory);
    await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ account }));
  }

  const previous = process.env.CODEX_HOME;

  process.env.CODEX_HOME = homeA;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
  });

  const access = new AccessProfileService(config, process.env, getProviderAdapters);
  t.after(() => access.close());
  await access.store.locked('codex', async () => {
    const settings = await access.manifest('codex');
    const first = settings.profiles[0];
    const second = {
      ...first,
      id: 'second-test-profile',
      name: 'B',
      secretRef: await access.store.secret('codex', { CODEX_HOME: homeB }),
    };

    settings.profiles.push(second);
    settings.activeProfileId = second.id;
    await access.store.write('codex', settings);
  });

  const catalog = createGraphModelCatalog(config, {
    registry: async () => {
      const codex = await getExecutor('codex');
      const models = await codex!.catalog!(config);

      return { codex: models as CatalogModel[] };
    },
  });
  const templateId = 'a2372fd2-e591-41c8-964a-64d321e3c677';
  const saved = await graphCommand(config, 'template-save', {
    id: templateId, expectedRevision: null,
    document: {
      title: 'Упакованная задача', inputKind: 'documents',
      scope: {
        steps: [
          { id: 'source', title: 'Вход', kind: 'input' },
          { id: 'model', title: 'Модель', kind: 'agent', needs: ['source'], prompt: 'Разбери документ' },
        ],
        returns: ['model'],
      },
    },
  }) as { revision: string };
  const id = 'e3a94e8d-7b6b-4dd8-bfd5-e5d1a0b594d6';

  await graphCommand(config, 'start', {
    id, templateId, expectedRevision: saved.revision,
    modelRef: { provider: 'codex', model: 'test-model' },
    files: [{ name: 'synthetic.txt', text: 'Синтетический документ.' }],
  });
  const { job } = await graphCommand(config, 'claim', {}) as ClaimFixture;
  assert.ok(job);

  const helper = helperCommandFor({
    kind: 'packaged', root, node, helperDirectory: outDir,
  } as RuntimePaths, manifest, 'graph-workflow-model', []);
  const result = await runGraphModelJob(job, AbortSignal.timeout(30_000), config, {}, { catalog, helper });

  assert.ok('committed' in result, JSON.stringify(result));
  const savedRun = await graphCommand(config, 'result', { id }) as {
    rows: WorkflowRow[]; incomplete: boolean;
  };
  assert.equal(savedRun.incomplete, false, JSON.stringify({
    node: await graphCommand(config, 'node', { id, nodeId: job.nodeId }),
    calls: await readFile(marker, 'utf8').catch(() => ''),
  }));
  assert.equal(savedRun.rows.length, 1);
  assert.equal(savedRun.rows[0].text, 'B');

  const calls = (await readFile(marker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(calls.map(({ type, account }) => [type, account]), [['catalog', 'B'], ['model', 'B']]);
  assert.equal(calls[0].home, homeB);
  assert.ok(calls[1].home !== homeA && calls[1].home !== homeB);
});

test('потерянный ack settle доводится инвалидацией до принятого снимка', async (t) => {
  const { config, setClock } = await clockFixture(t);

  await setClock(Date.now());
  const document = {
    title: 'Одна ветка', inputKind: 'documents',
    scope: {
      returns: ['out'],
      steps: [
        { id: 'src', title: 'Источник', kind: 'input' },
        { id: 'a', title: 'A', kind: 'agent', needs: ['src'], prompt: 'сделай' },
        { id: 'out', title: 'Сборка', kind: 'join', mode: 'all', needs: ['a'] },
      ],
    },
  };
  const saved = await graphCommand(config, 'template-save', {
    id: 'a2372fd2-e591-41c8-964a-64d321e3c677', expectedRevision: null, document,
  }) as { revision: string };
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';

  await graphCommand(config, 'start', {
    id, templateId: 'a2372fd2-e591-41c8-964a-64d321e3c677', expectedRevision: saved.revision,
    modelRef: { provider: 'claude', model: 'fake' }, files: [{ name: 'a.txt', text: 'вход' }],
  });
  const reads: { status: string; revision: number }[] = [];
  let unavailableCalls = 0;
  let scopeRuns = 0;
  const receiver = (target: string) => {
    void graphCommand(config, 'read', { id: target }).then((graph) => {
      reads.push(graph as { status: string; revision: number });
    }).catch(() => {});
  };
  const workers = new GraphWorkflowWorkers({
    claim: () => graphCommand(config, 'claim', {}) as Promise<{ job: null; changed: []; pending: false }>,
    run: async (job) => ({ rows: [{ key: 'row-1', title: 'Готово', text: 'готово', sources: job.rows[0]?.sources ?? [] }] }),
    settle: async (job, result) => {
      await graphCommand(config, 'settle', {
        id: job.id, nodeId: job.nodeId, generation: job.generation, claimId: job.claimId, ...result,
      });
      throw new GraphCommandError(503, 'workflow_store_unavailable');
    },
    announce: (update) => receiver(update.id),
    unavailable: () => {
      unavailableCalls += 1;
    },
    invalidateRuns: () => {
      scopeRuns += 1;
      receiver(id);
    },
  });

  workers.wake();
  for (let attempt = 0; attempt < 100 && !reads.some((graph) => graph.status === 'done'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await workers.close();
  assert.ok(reads.some((graph) => graph.status === 'done'), 'принятый снимок виден без hello');
  assert.ok(unavailableCalls >= 1);
  void scopeRuns;
  const final = await graphCommand(config, 'read', { id }) as { status: string };

  assert.equal(final.status, 'done');
});
