import assert from 'node:assert/strict';
import test from 'node:test';

import { routeStartArgs, heldRegistryIdentity } from '../../server/src/lib/factoryRouteCli.ts';
import { detectStall } from '../../server/src/lib/stall.ts';

// Создание без старта: движок пишет полную проекцию попытки и штатно завершается,
// поэтому подтверждение не требует живого демона, а маркер HELD_START отличает
// удержание от обрыва. Барьеры порядка аргументов и классификации остановок.

const ROUTE_CONFIG = {
  routesDir: '/routes',
  stateDir: '/state',
  factoryControlDir: '/control',
};

const START_INPUTS = {
  task: '42',
  profile: 'demo',
  route: 'feature',
  ticketFile: '/state/tickets/t42.ticket.json',
};

test('holdStart добавляет --hold-start последним, не меняя прежний порядок', () => {
  const args = routeStartArgs(ROUTE_CONFIG, { ...START_INPUTS, holdStart: true });
  assert.equal(args[args.length - 1], '--hold-start');
  assert.deepEqual(args.slice(0, -1), routeStartArgs(ROUTE_CONFIG, START_INPUTS));
});

test('без holdStart флаг не появляется: прежние вызывающие стартуют сразу', () => {
  assert.equal(routeStartArgs(ROUTE_CONFIG, START_INPUTS).includes('--hold-start'), false);
  assert.equal(
    routeStartArgs(ROUTE_CONFIG, { ...START_INPUTS, holdStart: false }).includes('--hold-start'),
    false,
  );
});

const HELD_REGISTRY = {
  ATTEMPT_ID: 'a_0123456789abcdef0123456789abcdef',
  ROUTE_HASH: 'a'.repeat(64),
  HELD_START: '1',
  PROFILE: 'demo',
  ROUTE: 'feature',
  RUN_PROTOCOL: '2',
  CATALOG_PROTOCOL: 'route-v2',
  DELIVERY_MODE: 'disabled',
  STALLED_HUMAN: '0',
};

const HELD_OPTIONS = { profile: 'demo', route: 'feature' };

test('held identity подтверждается без живого демона и без ORCH_PID', () => {
  assert.ok(heldRegistryIdentity(HELD_REGISTRY, HELD_OPTIONS));
  assert.ok(heldRegistryIdentity({ ...HELD_REGISTRY, ORCH_PID: '' }, HELD_OPTIONS));
  assert.ok(heldRegistryIdentity({ ...HELD_REGISTRY, HELD_START: 'pending' }, HELD_OPTIONS));
});

test('переход pending→1 не меняет identity: счётчик подтверждений не сбрасывается', () => {
  assert.equal(
    heldRegistryIdentity({ ...HELD_REGISTRY, HELD_START: 'pending' }, HELD_OPTIONS),
    heldRegistryIdentity(HELD_REGISTRY, HELD_OPTIONS),
  );
});

test('held identity требует маркер и полную не stalled проекцию', () => {
  for (const patch of [
    { HELD_START: '' },
    { HELD_START: '0' },
    { ATTEMPT_ID: '' },
    { ROUTE_HASH: '' },
    { ROUTE: 'hunt' },
    { PROFILE: 'other' },
    { DELIVERY_MODE: 'pending' },
    { STALLED_HUMAN: '1' },
    { RUN_PROTOCOL: '1' },
    { CATALOG_PROTOCOL: 'legacy' },
  ]) {
    assert.equal(heldRegistryIdentity({ ...HELD_REGISTRY, ...patch }, HELD_OPTIONS), null,
      JSON.stringify(patch));
  }
  assert.equal(heldRegistryIdentity(null, HELD_OPTIONS), null);
});

test('held identity сверяет точные catalog/dispatch/runner ключи запуска', () => {
  const expectedCatalogHash = 'b'.repeat(64);
  const dispatchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const complete = {
    ...HELD_REGISTRY,
    CATALOG_HASH: expectedCatalogHash,
    QUEUE_DISPATCH_ID: dispatchId,
    RUNNER_OVERRIDE_PRIMARY: 'codex',
  };
  const options = {
    ...HELD_OPTIONS,
    expectedCatalogHash,
    queueDispatchId: dispatchId,
    runnerPrimaryOverride: 'codex',
  };
  assert.ok(heldRegistryIdentity(complete, options));
  for (const patch of [
    { CATALOG_HASH: 'c'.repeat(64) },
    { QUEUE_DISPATCH_ID: '00000000-0000-4000-8000-000000000002' },
    { RUNNER_OVERRIDE_PRIMARY: 'claude' },
  ]) {
    assert.equal(heldRegistryIdentity({ ...complete, ...patch }, options), null,
      JSON.stringify(patch));
  }
});

const line = (ts, event) => `${ts} [t42] route: ${event}`;
const HELD_LOG = [
  line('2026-11-15 10:00:00', 'конвейер создан без старта: ожидает ручного запуска'),
].join('\n');

test('удержанная попытка не классифицируется как обрыв', () => {
  assert.equal(detectStall({
    registry: { HELD_START: '1' },
    logText: HELD_LOG,
    daemonAlive: false,
  }), null);
});

test('подъём стенда удержанной попытки под живым демоном — не остановка', () => {
  assert.equal(detectStall({
    registry: { HELD_START: 'pending' },
    logText: HELD_LOG,
    daemonAlive: true,
  }), null);
});

test('оборванный подъём стенда без маркера готовности остаётся обрывом', () => {
  const stall = detectStall({
    registry: { HELD_START: 'pending' },
    logText: line('2026-11-15 10:00:00', 'узел measure: подготовка к исполнению'),
    daemonAlive: false,
  });
  assert.equal(stall?.kind, 'crashed');
});

test('прежняя классификация не изменилась: мёртвый демон без меток — обрыв', () => {
  const stall = detectStall({
    registry: {},
    logText: line('2026-11-15 10:00:00', 'узел measure: подготовка к исполнению'),
    daemonAlive: false,
  });
  assert.equal(stall?.kind, 'crashed');
  assert.equal(detectStall({
    registry: { STOPPED_SIGNAL: '1' },
    logText: HELD_LOG,
    daemonAlive: false,
  }), null);
});
