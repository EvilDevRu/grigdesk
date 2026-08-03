import assert from 'node:assert/strict';
import test from 'node:test';

import { factoryLaunchEnv } from '../../server/src/lib/factory-launch.js';
import { routeStartArgs } from '../../server/src/lib/factory-route-cli.js';

test('Cockpit passes every factory runtime root into the detached pipeline scope', () => {
  assert.deepEqual(factoryLaunchEnv({
    factoryHome: '/engine',
    profilesDir: '/profiles',
    stateDir: '/state',
    factoryConfigRoot: '/config',
  }, { FACTORY_SB_K: '7' }), {
    FACTORY_SB_K: '7',
    FACTORY_HOME: '/engine',
    FACTORY_PROFILES_DIR: '/profiles',
    FACTORY_STATE: '/state',
    STATE_DIR: '/state',
    FACTORY_CONFIG_ROOT: '/config',
  });
});

const ROUTE_CONFIG = {
  routesDir: '/routes',
  stateDir: '/state',
  factoryControlDir: '/control',
};

test('routeStartArgs puts --runner-primary right after --ticket-json', () => {
  const args = routeStartArgs(ROUTE_CONFIG, {
    task: '42',
    profile: 'demo',
    route: 'feature',
    ticketFile: '/state/tickets/t42.ticket.json',
    runnerPrimary: 'codex',
  });
  const ticketAt = args.indexOf('--ticket-json');
  assert.equal(args[ticketAt + 1], '/state/tickets/t42.ticket.json');
  // Порядок зафиксирован: выбор исполнителя идёт сразу за постановкой,
  // до каталогов и необязательных флагов.
  assert.equal(args[ticketAt + 2], '--runner-primary');
  assert.equal(args[ticketAt + 3], 'codex');
  assert.equal(args[ticketAt + 4], '--routes-dir');
});

test('routeStartArgs without runnerPrimary keeps the canonical argument order', () => {
  const args = routeStartArgs(ROUTE_CONFIG, {
    task: '42',
    profile: 'demo',
    route: 'feature',
    ticketFile: '/state/tickets/t42.ticket.json',
  });
  assert.equal(args.includes('--runner-primary'), false);
  assert.deepEqual(args, [
    '42', 'start', '--profile', 'demo', '--route', 'feature',
    '--ticket-json', '/state/tickets/t42.ticket.json',
    '--routes-dir', '/routes', '--state-dir', '/state', '--control-dir', '/control',
  ]);
});
