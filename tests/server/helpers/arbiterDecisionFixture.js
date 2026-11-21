import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { readFactoryAttemptLedger } from '../../../server/src/lib/factoryAttemptLedger.ts';
import { testFactoryBinary } from '../../helpers/factoryBinary.mjs';
import { writeFactoryLedger } from '../../helpers/factoryLedgerFixture.mjs';

const execute = promisify(execFile);
const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const engineHome = path.join(repository, 'engine');

/**
 * Go store создаёт content-addressed события и runtime projection.
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
  const task = '7';
  const attempt = writeFactoryLedger(root, 'begin', {
    task,
    profile: 'demo-profile',
    route: 'debug',
  });
  const commit = (node, outcome, verdict) => writeFactoryLedger(root, 'commit', {
    task,
    attempt,
    node,
    outcome,
    failureOwner: verdict?.owner,
    verdict,
  });

  commit('instrument', 'done');
  commit('check', 'failed', {
    owner: 'tests', findings: [
      {
        id: 'timeout',
        severity: 'blocking',
        summary: 'Проверка не завершилась за отведённое время.'
      },
    ]
  });

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
  const rewind = (node, reason, expected, actor = 'human') => writeFactoryLedger(root, 'rewind', {
    task,
    attempt,
    node,
    reason,
    actor,
    sequence: expected?.sequence,
    head: expected?.headEventHash,
  });

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
    commit,
    rewind,
    config: {
      rootDir: repository,
      factoryHome: engineHome,
      factoryBin: testFactoryBinary(),
      factoryControlDir: controlDir,
      factoryConfigRoot: path.join(root, 'config'),
      routesDir,
      stateDir,
      profilesDir
    }
  };
}
