import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from '../../server/src/lib/analysis/analyzer.js';
import analysisModule from '../../server/src/modules/analysis/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function analyzerStub() {
  return {
    async enqueue() { return { outcome: 'queued' }; },
    async list() { return []; },
    async get(id) { return { task: Number(id) }; },
    async readClarifications() { return ''; },
    async appendClarification(_id, text) { return text; },
    async dismiss() { return { outcome: 'dismissed' }; },
  };
}

async function fixture(t, { enabled = false, arbiter = null } = {}) {
  let liveEnabled = enabled;
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', (id) => id === 'analysis' && liveEnabled);
  await app.register(analysisModule, { analyzer: analyzerStub(), arbiter });
  t.after(() => app.close());

  return {
    app,
    setEnabled(value) {
      liveEnabled = value;
    },
  };
}

test('выключенный триаж закрывает все семь ручек единым plugin_disabled', async (t) => {
  const { app } = await fixture(t);
  const requests = [
    ['POST', '/api/tasks/42/analyze', {}],
    ['GET', '/api/analysis'],
    ['GET', '/api/analysis/42'],
    ['GET', '/api/tasks/42/clarifications'],
    ['POST', '/api/tasks/42/clarifications', { text: 'ответ' }],
    ['DELETE', '/api/analysis/42/status'],
    ['POST', '/api/tasks/42/analysis/arbitrate', {}],
  ];
  const actual = [];

  for (const [method, url, payload] of requests) {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    actual.push([method, url, response.statusCode, response.json().error]);
  }

  assert.deepEqual(actual, requests.map(([method, url]) => [
    method,
    url,
    404,
    'plugin_disabled',
  ]));
});

test('живой тумблер закрывает и возвращает триаж без перерегистрации', async (t) => {
  const { app, setEnabled } = await fixture(t, { enabled: true });
  const before = await app.inject({ method: 'GET', url: '/api/analysis' });
  setEnabled(false);
  const disabled = await app.inject({ method: 'GET', url: '/api/analysis' });
  setEnabled(true);
  const after = await app.inject({ method: 'GET', url: '/api/analysis' });

  assert.deepEqual({
    before: [before.statusCode, before.json()],
    disabled: [disabled.statusCode, disabled.json().error],
    after: [after.statusCode, after.json()],
  }, {
    before: [200, []],
    disabled: [404, 'plugin_disabled'],
    after: [200, []],
  });
});

test('выключение и повторное включение не меняет сохранённую оценку и уточнения', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'analysis-plugin-data-'));
  const analysisDir = path.join(root, 'analysis');
  await mkdir(analysisDir);
  const analysisPath = path.join(analysisDir, 't42.analysis.json');
  const clarificationPath = path.join(analysisDir, 't42.clarify.md');
  const analysisBytes = '{"task":42,"summary":"сохранённая оценка","questions":[]}\n';
  const clarificationBytes = '## Ответ человека\nОставить ручной режим.\n';
  await writeFile(analysisPath, analysisBytes);
  await writeFile(clarificationPath, clarificationBytes);
  const analyzer = new Analyzer({
    config: { analysisDir },
    claudeAuth: null,
    b24: null,
    factoryState: {},
    log: null,
  });
  await analyzer._ready;
  let liveEnabled = true;
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => liveEnabled);
  await app.register(analysisModule, { analyzer });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const before = await app.inject({ method: 'GET', url: '/api/analysis/42' });
  liveEnabled = false;
  const disabled = await app.inject({ method: 'GET', url: '/api/analysis/42' });
  liveEnabled = true;
  const after = await app.inject({ method: 'GET', url: '/api/analysis/42' });
  const clarifications = await app.inject({
    method: 'GET',
    url: '/api/tasks/42/clarifications',
  });

  assert.deepEqual({
    statuses: [before.statusCode, disabled.statusCode, after.statusCode],
    summaries: [before.json().analysis?.summary, after.json().analysis?.summary],
    clarificationResponse: clarifications.json().text,
    analysisBytes: await readFile(analysisPath, 'utf8'),
    clarificationBytes: await readFile(clarificationPath, 'utf8'),
  }, {
    statuses: [200, 404, 200],
    summaries: ['сохранённая оценка', 'сохранённая оценка'],
    clarificationResponse: clarificationBytes,
    analysisBytes,
    clarificationBytes,
  });
});

test('ручной разбор вопроса доступен при выключенном автоматическом режиме', async (t) => {
  const calls = [];
  const arbiter = {
    async arbitrate(id) {
      calls.push(id);
      return { outcome: 'answered', answered: 1 };
    },
  };
  const { app } = await fixture(t, { enabled: true, arbiter });
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/42/analysis/arbitrate',
    payload: {},
  });

  assert.deepEqual({
    status: response.statusCode,
    body: response.json(),
    calls,
  }, {
    status: 200,
    body: { outcome: 'answered', answered: 1 },
    calls: ['42'],
  });
});
