import assert from 'node:assert/strict';
import test from 'node:test';

import { factoryLaunchEnv } from '../../server/src/lib/factoryLaunch.ts';
import { routeStartArgs, stageAutoCompactEnv } from '../../server/src/lib/factoryRouteCli.ts';

test('GrigDesk passes every factory runtime root into the detached pipeline scope', () => {
  assert.deepEqual(factoryLaunchEnv({
    dataHome: '/data/grigdesk',
    factoryHome: '/engine',
    profilesDir: '/profiles',
    stateDir: '/state',
    factoryConfigRoot: '/config',
  }, { FACTORY_SB_K: '7' }), {
    FACTORY_SB_K: '7',
    GRIGDESK_HOME: '/data/grigdesk',
    FACTORY_HOME: '/engine',
    FACTORY_PROFILES_DIR: '/profiles',
    FACTORY_STATE: '/state',
    STATE_DIR: '/state',
    FACTORY_CONFIG_ROOT: '/config',
  });
});

test('порог автосжатия этапа уезжает движку всегда, включая осознанный ноль', () => {
  assert.deepEqual(stageAutoCompactEnv({ stageAutoCompactWindow: 200000 }), {
    FACTORY_STAGE_AUTO_COMPACT: '200000',
  });
  // Ноль — это «не вмешиваться», и он обязан ДОЕХАТЬ: пустое значение движок читает как
  // «спроси профиль» (AUTO_COMPACT_WINDOW в его runners.env), то есть выбор человека
  // молча проиграл бы настройке проекта.
  assert.deepEqual(stageAutoCompactEnv({ stageAutoCompactWindow: 0 }), {
    FACTORY_STAGE_AUTO_COMPACT: '0',
  });
  // Мусор и отсутствие настройки — тот же ноль, а не строка «NaN» в окружении юнита.
  for (const prefs of [{}, undefined, { stageAutoCompactWindow: 'много' }, { stageAutoCompactWindow: -5 }]) {
    assert.deepEqual(stageAutoCompactEnv(prefs), { FACTORY_STAGE_AUTO_COMPACT: '0' });
  }
  // Дробное значение из ручного правки файла настроек не уезжает дробным: движок
  // сверяет его регуляркой ^[0-9]+$ и «200000.5» отбросил бы в ноль целиком.
  assert.deepEqual(stageAutoCompactEnv({ stageAutoCompactWindow: 200000.5 }), {
    FACTORY_STAGE_AUTO_COMPACT: '200001',
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
