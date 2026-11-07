import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { readFactoryAttemptLedger } from '../../../server/src/lib/factoryAttemptLedger.ts';
import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';

const execute = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const engineHome = path.join(repository, 'engine');

/**
 * Настоящий stage-state helper создаёт content-addressed события и runtime projection.
 * Все roots принадлежат тесту, команды профиля и живые модели не запускаются.
 */
export async function arbiterDecisionFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arbiter-real-ledger-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const controlDir = path.join(root, 'control');
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');

  await Promise.all([stateDir, controlDir, profilesDir].map((dir) => fs.mkdir(dir, { mode: 0o700 })));

  const published = JSON.parse((await execute(process.execPath, [
    path.join(repository, 'tests/engine/fixtures/routes-publish.mjs'), routesDir,
    'Диагностика', 'null', '"performance"', JSON.stringify({
      instrument: 'Подготовка проверок',
      check: 'Проверка',
      retro: 'Подведение итогов',
    }),
  ])).stdout);
  const env = {
    ...process.env,
    FACTORY_HOME: engineHome,
    FACTORY_CONTROL_ROOT: controlDir,
    FACTORY_PROFILES_DIR: profilesDir,
    FACTORY_STATE: stateDir,
    STATE_DIR: stateDir,
    NODE_BIN: process.execPath,
    FACTORY_FORBID_LIVE: '1',
    PYTHONDONTWRITEBYTECODE: '1'
  };
  const call = async (operation, ...args) => execute('bash', ['-c',
    'set -uo pipefail\nsource "$FACTORY_HOME/lib/attempt-stage-state.sh"\n"$@"',
    'arbiter-fixture', operation, ...args.map(String)], { env, maxBuffer: 2 * 1024 * 1024 });
  const attempt = (await call('attempt_state_begin_v2', '7', 'demo-profile', routesDir)).stdout.trim();

  await call('attempt_state_select_route_v2', '7', attempt, 'debug');
  await call('attempt_stage_state_init_v2', '7', attempt, 'debug');
  await call('attempt_stage_state_commit_v2', '7', attempt, 'instrument', 'done');

  const verdict = Buffer.from(canonicalJson({
    owner: 'tests', findings: [
      {
        id: 'timeout',
        severity: 'blocking',
        summary: 'Проверка не завершилась за отведённое время.'
      },
    ]
  })).toString('base64');

  await call('attempt_stage_state_commit_v2', '7', attempt, 'check', 'failed', '0', verdict);

  const attemptDir = path.join(controlDir, 'protocol-v2/tasks/t7/attempts', attempt);

  await fs.writeFile(path.join(attemptDir, 'artifacts/profile-contract.tsv'), [
    'schema\t1', 'repos-mode\tgeneric', 'workspace-mode\tisolated', 'stand-ownership\ttask',
    'source-branch\tfixture', 'container\tdemo', 'service-host\t127.0.0.1',
    `repo\tdemo\t${root}\t${root}\tfixture`, '',
  ].join('\n'), { mode: 0o400 });

  const registry = {
    CATALOG_PROTOCOL: 'route-v2',
    ATTEMPT_ID: attempt,
    PROFILE: 'demo-profile',
    ROUTE: 'debug',
    ROUTE_HASH: published.routeHash,
    CATALOG_HASH: published.catalogHash
  };
  const trusted = () => readFactoryAttemptLedger({
    controlDir,
    stateDir,
    task: '7',
    registry
  });
  const rewind = (node, reason, expected, actor = 'human') => call('attempt_stage_state_human_rewind_v2',
    '7', attempt, node, node === 'instrument' ? 'instrument,check,gate_plan,retro' : 'check,gate_plan,retro',
    reason, actor, expected?.sequence ?? '', expected?.headEventHash ?? '');

  return {
    root,
    controlDir,
    stateDir,
    profilesDir,
    routesDir,
    attempt,
    attemptDir,
    registry,
    trusted,
    call,
    rewind,
    config: {
      rootDir: repository,
      factoryHome: engineHome,
      factoryBin: path.join(engineHome, 'bin/factory'),
      factoryControlDir: controlDir,
      factoryConfigRoot: path.join(root, 'config'),
      routesDir,
      stateDir,
      profilesDir
    }
  };
}
