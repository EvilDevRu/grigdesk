import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as routeCli from '../../server/src/lib/factoryRouteCli.ts';
import { factoryDecisionFixture } from './helpers/factoryDecisionFixture.js';
import { ArbiterConversationService } from '../../server/src/lib/arbiterConversationService.ts';

/**
 * Подставной бинарь проверяет настоящий execFile без обращения к живому движку.
 * Временные пути принадлежат одному тесту и удаляются после его завершения.
 */
async function fixture(t, script, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-route-decision-'));
  const factoryBin = path.join(root, 'factory');

  await writeFile(factoryBin, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  t.after(() => rm(root, { recursive: true, force: true }));

  return {
    rootDir: root,
    factoryHome: root,
    factoryBin,
    factoryControlDir: path.join(root, 'control'),
    factoryConfigRoot: path.join(root, 'config'),
    routesDir: path.join(root, 'routes'),
    stateDir: path.join(root, 'state'),
    profilesDir: path.join(root, 'profiles'),
    ...overrides,
  };
}

test('runRouteEngine помечает убийство по сроку', async (t) => {
  const noise = 'runtime analytics: open orchestrator session is unavailable';
  const config = await fixture(t, `echo '${noise}' >&2\necho FACTORY_ERROR=runner_preflight_failed >&2\n`
    + 'exec sleep 5');

  const result = await routeCli.runRouteEngine(config, [], { timeout: 300 });

  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.failure, null);
  assert.equal(result.message, 'движок не уложился за 0.3 с');
  assert.ok(!result.message.includes(noise));
  assert.ok(result.stderr.includes(noise));
});

test('обычный отказ движка не считается сроком', async (t) => {
  const config = await fixture(t, 'echo boom >&2\nexit 3');

  const result = await routeCli.runRouteEngine(config, []);

  assert.equal(result.timedOut, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.ok(result.message.includes('boom'));
});

test('runRouteDecision берёт срок из config.decisionTimeoutMs', async (t) => {
  const config = await fixture(t, 'exec sleep 5', { decisionTimeoutMs: 300 });
  const started = performance.now();

  assert.equal(typeof routeCli.runRouteDecision, 'function');

  const result = await routeCli.runRouteDecision(config, []);

  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - started < 3000);
  assert.equal(routeCli.ROUTE_DECISION_TIMEOUT_MS, 180_000);
});

test('кнопка продолжения проходит барьер остановки арбитра до запуска движка', async (t) => {
  const original = ArbiterConversationService.prototype.withReadStopped;
  const stopped = [];

  t.mock.method(ArbiterConversationService.prototype, 'withReadStopped', function (task, action) {
    stopped.push(task);

    return original.call(this, task, action);
  });

  const fx = await factoryDecisionFixture(t);
  const response = await fx.app.inject({ method: 'POST', url: '/api/tasks/7/resume' });

  assert.deepEqual(stopped, ['7']);
  assert.equal(response.statusCode, 500, 'подставной юнит завершается без живого оркестратора');
  assert.match(await readFile(fx.callsLog, 'utf8'), /systemd-run .*7 resume /);
});

test('«Перейти сюда» после срока продолжает прогон, если возврат записан', async (t) => {
  const fx = await factoryDecisionFixture(t, {
    after: {
      node: 'build',
      state: 'ready',
      sequence: 9,
    },
  });

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/stage/BUILD/running',
    payload: { comment: 'исправь замечание' },
  });
  const body = response.json();
  const calls = await readFile(fx.callsLog, 'utf8');

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.ok, true);
  assert.equal(body.engineTimedOut, true);
  assert.match(calls, /systemd-run .*7 resume --profile demo/);
  assert.equal(calls.match(/factory 7 goto /g)?.length, 1);
  assert.ok(fx.warnings.some(({ fields }) => fields.task === '7' && fields.timeoutMs === 500));
  assert.equal(fx.adapter.isRunLive('', '7'), false);
});

test('«Перейти сюда» после срока без записи отвечает 504', async (t) => {
  const fx = await factoryDecisionFixture(t);

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/stage/BUILD/running',
  });

  assert.equal(response.statusCode, 504, response.body);
  assert.deepEqual(response.json(), {
    error: 'engine_timeout',
    message: 'Движок не уложился за 0.5 с, решение в журнале не найдено — обнови карточку и повтори.',
  });
  assert.doesNotMatch(await readFile(fx.callsLog, 'utf8'), /systemd-run/);
  assert.equal(fx.adapter.isRunLive('', '7'), false);
});

test('ворота после срока: approve записан', async (t) => {
  const fx = await factoryDecisionFixture(t, {
    after: { state: 'stopped', sequence: 9 },
  });

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().engineTimedOut, true);
  assert.equal(response.json().value, 'approved');
  assert.match(await readFile(fx.callsLog, 'utf8'), /systemd-run .*7 resume /);
});

test('ворота после срока: reject записан', async (t) => {
  const fx = await factoryDecisionFixture(t, {
    after: {
      node: 'build',
      state: 'ready',
      sequence: 9,
    },
  });

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/reject',
    payload: { comment: 'верни на доработку' },
  });
  const calls = await readFile(fx.callsLog, 'utf8');

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().engineTimedOut, true);
  assert.equal(response.json().value, 'rejected');
  assert.match(calls, /systemd-run .*7 resume /);
  assert.equal(calls.match(/factory 7 gate /g)?.length, 1);
});

test('ворота после срока без записи отвечают 504', async (t) => {
  const fx = await factoryDecisionFixture(t);

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
  });

  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json().error, 'engine_timeout');
  assert.doesNotMatch(await readFile(fx.callsLog, 'utf8'), /systemd-run/);
});

test('новый sequence на прежних воротах не подтверждает решение', async (t) => {
  const fx = await factoryDecisionFixture(t, { after: { sequence: 9 } });

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/gate/GATE_ACCEPT/approve',
  });

  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json().error, 'engine_timeout');
  assert.doesNotMatch(await readFile(fx.callsLog, 'utf8'), /systemd-run/);
});

test('целевой узел без нового sequence не подтверждает возврат', async (t) => {
  const fx = await factoryDecisionFixture(t, {
    before: { node: 'build', state: 'ready' },
  });

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/stage/BUILD/running',
  });

  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json().error, 'engine_timeout');
  assert.doesNotMatch(await readFile(fx.callsLog, 'utf8'), /systemd-run/);
});

test('ошибка повторного trusted чтения после срока даёт 504 без resume', async (t) => {
  const fx = await factoryDecisionFixture(t, { corruptAfter: true });
  const readTrustedAttempt = fx.adapter.readTrustedAttempt.bind(fx.adapter);
  const reads = [];

  fx.adapter.readTrustedAttempt = (id, registry) => {
    reads.push(registry);

    return readTrustedAttempt(id, registry);
  };

  const response = await fx.app.inject({
    method: 'POST',
    url: '/api/tasks/7/stage/BUILD/running',
  });

  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json().error, 'engine_timeout');
  assert.equal(reads.length, 2);
  assert.equal(reads[1], undefined, 'повторное чтение берёт свежий реестр');
  assert.doesNotMatch(await readFile(fx.callsLog, 'utf8'), /systemd-run/);
});

test('решения движка идут только через runRouteDecision', async () => {
  const source = await readFile(
    new URL('../../server/src/modules/factory/index.ts', import.meta.url),
    'utf8',
  );
  const direct = /runRouteEngine\(\s*config,\s*route(Gate|Goto|Abandon|BootstrapAnswer)Args/g;

  assert.equal(source.match(direct)?.length || 0, 0);
});
