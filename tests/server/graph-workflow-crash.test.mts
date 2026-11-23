import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { graphCommand, GraphCommandError } from '../../server/src/lib/graphWorkflows.ts';
import { buildTestGo } from '../helpers/goBuildFixture.mts';

const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const HOST = fileURLToPath(new URL('../fixtures/graph-workflow/host.mts', import.meta.url));

interface ServeChild {
  child: ChildProcess;
  origin: string;
  calls: { nodeId: string; generation: number }[];
}

/**
 * Поднимает отдельный процесс стенда с приватным root и clock-фикстурой.
 * IPC считает фактические вызовы fake model в родителе.
 */
async function startServe(t: { after: (fn: () => Promise<void>) => void }, root: string, clockFile: string, clockBin: string): Promise<ServeChild> {
  const child = fork(HOST, ['--serve'], {
    env: {
      ...process.env,
      TEST_GRAPH_FIXTURE_ROOT: root,
      TEST_GRAPH_FACTORY_BIN: clockBin,
      GRAPH_TEST_CLOCK_FILE: clockFile,
      TEST_GRAPH_CRASH_MODEL: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const calls: { nodeId: string; generation: number }[] = [];

  child.on('message', (message: unknown) => {
    const value = message as { type?: string; nodeId?: string; generation?: number };

    if (value?.type === 'model-call') {
      calls.push({ nodeId: value.nodeId!, generation: value.generation! });
    }
  });
  const origin = await new Promise<string>((resolve, reject) => {
    let buffered = '';

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffered += chunk;

      const line = buffered.split('\n')[0];

      if (line?.startsWith('http://')) {
        resolve(line.trim());
      }
    });
    child.once('error', reject);
    setTimeout(() => reject(new Error('стенд не поднялся: ' + buffered)), 15000).unref();
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  });
  return { child, origin, calls };
}

async function sessionCookie(root: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const raw = await readFile(path.join(root, 'sessions.json'), 'utf8');
      const document = JSON.parse(raw) as { sessions?: Record<string, number> };
      const ids = Object.keys(document.sessions ?? {});

      if (ids.length) {
        return 'grigdesk_sid=' + ids[0];
      }
    } catch {
      // файл ещё не записан
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('сессия стенда не найдена');
}

test('возобновление после SIGKILL: прерванная выдача повторяется, независимая сохранена', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-crash-'));
  const clockFile = path.join(root, 'clock');
  const clockBin = path.join(root, 'factory-clock-fixture');

  execFileSync('go', ['test', '-c', '-o', clockBin, './utilities/factory/internal/cli'], {
    cwd: repo, env: { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off' },
  });
  const startClock = Date.now();

  await writeFile(clockFile, String(startClock));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await startServe(t, root, clockFile, clockBin);
  const cookie = await sessionCookie(root);
  const http = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(first.origin + url, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const document = {
    title: 'Две ветки', inputKind: 'documents',
    scope: {
      returns: ['out'],
      steps: [
        { id: 'src', title: 'Источник', kind: 'input' },
        { id: 'left', title: 'Левый', kind: 'agent', needs: ['src'], prompt: 'лево' },
        { id: 'right', title: 'Правый', kind: 'agent', needs: ['src'], prompt: 'право' },
        { id: 'out', title: 'Сборка', kind: 'join', mode: 'all', needs: ['left', 'right'] },
      ],
    },
  };
  const templateId = 'a2372fd2-e591-41c8-964a-64d321e3c677';
  const save = await http('POST', '/api/graph-workflows/templates/save', { id: templateId, expectedRevision: null, document });

  assert.equal(save.status, 200);
  const id = '74906bac-48d5-40ce-a6a9-96cbce242146';
  const start = await http('POST', '/api/graph-workflows/runs', {
    id, templateId, expectedRevision: save.json.revision,
    modelRef: { provider: 'claude', model: 'fake' }, files: [{ name: 'a.txt', text: 'вход' }],
  });

  assert.equal(start.status, 202);
  const waitFor = async (
    request: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }>,
    predicate: (graph: { nodes: { id: string; status: string; generation: number; errorCode?: string }[]; revision: number; status: string }) => boolean,
  ) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const graph = (await request('GET', '/api/graph-workflows/runs/' + id)).json;

      if (graph && predicate(graph)) {
        return graph;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('состояние не достигнуто');
  };
  await waitFor(http, (graph) => graph.nodes.some((node) => node.id === 'left' && node.status === 'running')
    && graph.nodes.some((node) => node.id === 'right' && node.status === 'done'));

  assert.ok(first.calls.some((call) => call.nodeId === 'left' && call.generation === 1));
  assert.ok(first.calls.some((call) => call.nodeId === 'right' && call.generation === 1));
  first.child.kill('SIGKILL');
  await new Promise((resolve) => first.child.once('exit', resolve));
  await writeFile(clockFile, String(startClock + 360000 + 1));

  const second = await startServe(t, root, clockFile, clockBin);
  const cookie2 = await sessionCookie(root);
  const http2 = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(second.origin + url, {
      method,
      headers: { cookie: cookie2, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const afterRestart = await waitFor(http2, (graph) => graph.nodes.some((node) => node.id === 'left' && node.status === 'failed'));
  const left = afterRestart.nodes.find((node: { id: string }) => node.id === 'left')!;

  assert.equal((left as { errorCode?: string }).errorCode, 'interrupted');
  const rightCallsBefore = second.calls.filter((call) => call.nodeId === 'right').length;

  assert.equal(rightCallsBefore, 0);
  const retry = await http2('POST', '/api/graph-workflows/runs/' + id + '/action', {
    nodeId: 'left', generation: left.generation, action: 'retry', expectedRevision: afterRestart.revision,
  });

  assert.equal(retry.status, 200);
  const done = await waitFor(http2, (graph) => graph.status === 'done');

  assert.equal(done.nodes.find((node: { id: string; generation: number }) => node.id === 'left')!.generation, 2);
  const result = (await http2('GET', '/api/graph-workflows/runs/' + id + '/result')).json;

  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.missing, []);
  for (let attempt = 0; attempt < 40 && !second.calls.some((call) => call.nodeId === 'left' && call.generation === 2); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const totalRight = first.calls.filter((call) => call.nodeId === 'right').length
    + second.calls.filter((call) => call.nodeId === 'right').length;
  const totalLeft = first.calls.filter((call) => call.nodeId === 'left').length
    + second.calls.filter((call) => call.nodeId === 'left').length;

  assert.equal(totalRight, 1);
  assert.equal(totalLeft, 2);
  const config = {
    factoryBin: process.env.TEST_GRAPH_FACTORY_BIN
      ?? buildTestGo('graph-factory', ['build'], './utilities/factory/cmd/factory'),
    factoryControlDir: path.join(root, 'control'),
    rootDir: repo,
  };
  const stale = await graphCommand(config, 'settle', {
    id, nodeId: 'left', generation: 1, claimId: 'stale-token',
    rows: [{ key: 'row-1', title: 'Поздний', text: 'устарел' }],
  }).catch((error: unknown) => error);

  assert.ok(stale instanceof GraphCommandError);
  assert.equal((stale as GraphCommandError).status, 409);
});