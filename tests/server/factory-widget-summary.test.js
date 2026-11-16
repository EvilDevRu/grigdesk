import assert from 'node:assert/strict';
import test from 'node:test';
import { factoryWidgetCounters } from '../../server/src/lib/factoryWidget.ts';

function task(overrides = {}) {
  return {
    result: null,
    readOnly: false,
    stalledHuman: false,
    bootstrapStop: null,
    stall: null,
    daemonAlive: false,
    stageMap: {},
    ...overrides,
  };
}

test('виджет: живой демон считается работой, простой не считается', () => {
  assert.deepEqual(factoryWidgetCounters([task({ daemonAlive: true }), task()]),
    { running: 1, waiting: 0, stalled: 0 });
});

test('виджет: завершённые и read-only проекции пропускаются', () => {
  assert.deepEqual(factoryWidgetCounters([
    task({ result: 'completed', daemonAlive: true }),
    task({ result: 'abandoned' }),
    task({ readOnly: true, stalledHuman: true }),
  ]), { running: 0, waiting: 0, stalled: 0 });
});

test('виджет: ворота route-v2 в заглавных ключах реестра считаются ожиданием', () => {
  assert.deepEqual(factoryWidgetCounters([
    task({ stalledHuman: true }),
    task({ bootstrapStop: { state: 'waiting' } }),
    task({ bootstrapStop: { state: 'answered' } }),
    task({ stall: { kind: 'human' } }),
    task({ stageMap: { GATE_PLAN: { status: 'waiting' } } }),
    task({ stageMap: { GATE_ACCEPT: { status: 'waiting' } } }),
  ]), { running: 0, waiting: 6, stalled: 0 });
});

test('виджет: сравнение ворот без регистра ловит нижний регистр и статусы графа', () => {
  assert.deepEqual(factoryWidgetCounters([
    task({ stageMap: { gate_plan: { status: 'wait' } } }),
    task({ stageMap: { GATE_CAUSE: { status: 'premature' } } }),
  ]), { running: 0, waiting: 2, stalled: 0 });
});

test('виджет: идущая разведка после ответа считается работой, не ожиданием', () => {
  assert.deepEqual(factoryWidgetCounters([
    task({ bootstrapStop: { state: 'running' }, daemonAlive: true }),
  ]), { running: 1, waiting: 0, stalled: 0 });
});

test('виджет: крах демона считается остановкой, чужие узлы не ловятся', () => {
  assert.deepEqual(factoryWidgetCounters([
    task({ stall: { kind: 'crashed' } }),
    task({ stageMap: { build: { status: 'wait' } } }),
  ]), { running: 0, waiting: 0, stalled: 1 });
});

test('виджет: ожидание человека важнее живого демона', () => {
  assert.deepEqual(factoryWidgetCounters([
    task({ stalledHuman: true, daemonAlive: true }),
    task({ stall: { kind: 'human' }, daemonAlive: true }),
  ]), { running: 0, waiting: 2, stalled: 0 });
});

import { createRequire } from 'node:module';
import factoryModule from '../../server/src/modules/factory/index.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

// Регистрация проверена автором плана: factoryModule принимает фейковый listTasks,
// если config несёт factoryBin и factoryConfigRoot. Файлы при этом не читаются.
async function server(t, tasks) {
  const app = Fastify({ logger: false });

  await app.register(factoryModule, {
    factoryState: { listTasks: async () => tasks },
    config: {
      rootDir: '/tmp/grigdesk-widget',
      stateDir: '/tmp/grigdesk-widget/state',
      profilesDir: '/tmp/grigdesk-widget/profiles',
      factoryHome: '/tmp/grigdesk-widget',
      factoryControlDir: '/tmp/grigdesk-widget/control',
      routesDir: '/tmp/grigdesk-widget/routes',
      ticketsDir: '/tmp/grigdesk-widget/tickets',
      factoryProfile: 'demo',
      sandboxDownCmd: '',
      factoryBin: '/tmp/grigdesk-widget/bin/factory',
      factoryConfigRoot: '/tmp/grigdesk-widget/config',
    },
    prefs: { read: () => ({}) },
    tracker: null,
    analyzer: { readClarifications: async () => null, readOpenQuestions: async () => null },
  });
  await app.ready();
  t.after(async () => app.close());

  return app;
}

test('виджет: endpoint отдаёт счётчики и отметку без текста задач', async (t) => {
  const app = await server(t, [
    task({ daemonAlive: true }),
    task({ stalledHuman: true }),
    task({ stall: { kind: 'crashed' } }),
    task({ result: 'completed' }),
  ]);
  const response = await app.inject({ method: 'GET', url: '/api/factory/widget-summary' });

  assert.equal(response.statusCode, 200);

  const body = response.json();

  assert.equal(body.running, 1);
  assert.equal(body.waiting, 1);
  assert.equal(body.stalled, 1);
  assert.match(body.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(Object.keys(body).sort(), ['at', 'running', 'stalled', 'waiting']);
});

test('виджет: пустой конвейер отдаёт нули', async (t) => {
  const app = await server(t, []);
  const response = await app.inject({ method: 'GET', url: '/api/factory/widget-summary' });

  assert.equal(response.statusCode, 200);

  const body = response.json();

  assert.equal(body.running, 0);
  assert.equal(body.waiting, 0);
  assert.equal(body.stalled, 0);
  assert.equal(typeof body.at, 'string');
});
