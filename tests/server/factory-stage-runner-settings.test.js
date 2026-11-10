import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { applyPayload, selection, waitFor } from '../helpers/stageRunnerSettingsFixture.mjs';
import { httpJson, settingsServer } from '../helpers/stageRunnerSettingsServer.mjs';

// К1/К5/К6: HTTP → pinned factory CLI → trusted file → повторный GET без mock storage.
test('options-and-apply-exact-identity', async (t) => {
  const fx = await settingsServer(t);
  const profile = await readFile(fx.config.profilesDir + '/demo-profile/runners.env');
  const options = httpJson(await fx.get());
  const payload = applyPayload(options);
  const saved = httpJson(await fx.post(payload));
  const stored = JSON.parse(await readFile(fx.record, 'utf8'));
  const reopened = httpJson(await fx.get());

  assert.deepEqual(saved.selection, payload.selection);
  assert.deepEqual(stored.identity, fx.identity);
  assert.deepEqual(stored.selection, payload.selection);
  assert.deepEqual(reopened.selection, payload.selection);
  assert.deepEqual(await readFile(fx.config.profilesDir + '/demo-profile/runners.env'), profile);
  assert.deepEqual(await fx.captures(), [], 'pending save не запускает provider');

  const calls = await fx.engineCalls();
  const apply = calls.find((args) => args.slice(0, 4).join(' ') === '81 runner settings apply');

  assert.ok(apply, 'HTTP мутация вызвала реальный pinned CLI');

  for (const [flag, value] of [
    ['--profile', fx.identity.profile], ['--attempt', fx.identity.attempt],
    ['--node', 'plan'], ['--stage', 'PLAN'],
  ]) {
    assert.equal(apply[apply.indexOf(flag) + 1], value);
  }

  assert.deepEqual(JSON.parse(apply[apply.indexOf('--payload') + 1]), payload);
});

test('active-next-and-same-provider-restart', async (t) => {
  const fx = await settingsServer(t);
  const active = fx.start({ FAKE_ALPHA_RESULT: 'wait' });
  const first = await waitFor(async () => (await fx.captures())[0], 'реальный live run');

  fx.graph.daemonAlive = true;
  fx.graph.statuses.plan = 'run';
  fx.graph.nodeMeta.plan.runner.actual = 'alpha';

  const options = httpJson(await fx.get());

  httpJson(await fx.post(applyPayload(options)));
  assert.equal(active.child.exitCode, null);
  assert.equal((await fx.captures()).length, 1);

  const current = httpJson(await fx.get());

  httpJson(await fx.post(applyPayload(current, selection('alpha-model', 'low'), 'restart', 'http-restart')));

  const rows = await waitFor(async () => {
    const captures = await fx.captures();

    return captures.length === 2 ? captures : null;
  }, 'same-provider restart через HTTP');

  assert.notEqual(rows[1].id, first.id);
  assert.ok(rows[1].epoch > first.epoch);
  assert.equal(rows[1].provider, 'alpha');
  assert.equal(rows[1].model, 'alpha-model');
  assert.equal(rows[1].effort, 'low');
});

test('bad-input-no-engine-effect', async (t) => {
  const fx = await settingsServer(t);
  const options = httpJson(await fx.get());

  httpJson(await fx.post(applyPayload(options)));

  const bytes = await readFile(fx.record);
  const current = httpJson(await fx.get());
  const payload = applyPayload(current, selection('alpha-model', 'high'), 'next', 'negative');
  const callsBefore = (await fx.engineCalls()).length;

  for (const mutation of [
    { extra: true }, { mode: 'anything' }, { selection: { ...payload.selection, effort: 10 } },
    { identity: { ...fx.identity, node: 'plan;false' } },
  ]) {
    httpJson(await fx.post({ ...payload, ...mutation }), 400);
    assert.deepEqual(await readFile(fx.record), bytes);
  }

  assert.equal((await fx.engineCalls()).length, callsBefore, 'синтаксический отказ до CLI');

  for (const mutation of [
    { expectedRevision: current.revision - 1 }, { catalogRevision: 'obsolete' },
    { identity: { ...fx.identity, profile: 'other' } },
    { identity: { ...fx.identity, node: 'ship' } },
    { expectedRun: { id: 'foreign-run', epoch: 99 } },
    { selection: selection('alpha-model', 'max') },
  ]) {
    const response = httpJson(await fx.post({ ...payload, ...mutation }), 409);

    assert.equal(typeof response.message, 'string');
    assert.ok(response.message.length > 0);
    assert.deepEqual(await readFile(fx.record), bytes);
    assert.deepEqual(await fx.captures(), []);
  }
});

test('actual-separate-from-future', async (t) => {
  const fx = await settingsServer(t);

  fx.start({ FAKE_ALPHA_RESULT: 'wait' });

  const first = await waitFor(async () => (await fx.captures())[0], 'фактическая пара запуска');
  const options = httpJson(await fx.get());

  assert.equal(options.actual.run.id, first.id);
  assert.equal(options.actual.model, 'alpha-model');
  assert.equal(options.actual.effort, 'high');
  httpJson(await fx.post(applyPayload(options)));

  const next = httpJson(await fx.get());

  assert.equal(next.effective.model, 'alpha-strong');
  assert.equal(next.effective.effort, 'max');
  assert.deepEqual(next.actual, options.actual);
});

// Новый сохранительный барьер К7: обе ручки закрыты общим auth до запуска CLI.
test('settings-api-requires-auth', async (t) => {
  const fx = await settingsServer(t);
  const before = await fx.engineCalls();

  for (const response of [
    await fx.get('alpha', fx.identity, false),
    await fx.post({ identity: fx.identity }, false),
  ]) {
    assert.ok([401, 404].includes(response.statusCode), response.body);
  }

  httpJson(await fx.app.inject({ url: '/api/tasks' }), 401);
  assert.deepEqual(await fx.engineCalls(), before);
});
