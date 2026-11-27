import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { testFactoryBinary } from './factoryBinary.mjs';
import { writeFactoryLedger } from './factoryLedgerFixture.mjs';

export const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Создаёт закреплённую попытку без запуска агента.
 * Каталог моделей запрашивается через штатную команду Go над этой попыткой.
 */
export async function settingsFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stage-models-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const task = '81';
  const profile = 'demo-profile';
  const routesDir = path.join(root, 'routes');
  const profileDir = path.join(root, 'profiles', profile);
  const stateDir = path.join(root, 'state');
  const controlDir = path.join(root, 'control');

  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(controlDir, { mode: 0o700 });
  await writeFile(path.join(profileDir, 'profile.sh'), 'PROFILE_NAME=demo-profile\n');

  execFileSync(process.execPath, [
    path.join(sourceRoot, 'tests/engine/fixtures/routes-catalog-publish.mjs'), routesDir,
  ], { env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 10_000 });

  const attempt = writeFactoryLedger(root, 'begin', {
    task,
    profile,
    route: 'feature',
  });
  const env = {
    HOME: root,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    GRIGDESK_HOME: path.join(root, 'data'),
    FACTORY_HOME: path.join(sourceRoot, 'engine'),
    FACTORY_PROFILES_DIR: path.dirname(profileDir),
    NODE_BIN: process.execPath,
  };

  return {
    root,
    task,
    profile,
    attempt,
    controlDir,
    env,
    config: path.join(profileDir, 'runners.env'),
    cli(operation, extra = [], node = 'plan', stage = 'PLAN') {
      return spawnSync(testFactoryBinary(), [task, 'runner', 'settings', operation,
        '--profile', profile, '--attempt', attempt, '--node', node, '--stage', stage,
        '--routes-dir', routesDir, '--control-dir', controlDir, '--state-dir', stateDir, ...extra,
      ], {
        env,
        encoding: 'utf8',
        timeout: 20_000,
      });
    },
  };
}

/**
 * Пишет доверенный снимок metadata scope попытки в формате Store.ReadStageMetadataScope.
 * Только для офлайн-фикстуры без запуска движка: schema 1, точная попытка, режим 0600,
 * digest содержимого каждой копии CLI — как их вычисляет Go при записи.
 */
export async function writeStageMetadataScope(fx, providers, metadataEnvironment, checkout = '') {
  const file = path.join(fx.controlDir, 'protocol-v2', 'tasks', `t${fx.task}`, 'attempts', fx.attempt,
    'runner-metadata.json');
  const entries = {};

  for (const [provider, entry] of Object.entries(providers)) {
    entries[provider] = {
      ...entry, digest: createHash('sha256').update(await readFile(entry.executable)).digest('hex'),
    };
  }

  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({
    schema: 1,
    task: fx.task,
    profile: fx.profile,
    attempt: fx.attempt,
    ...(checkout ? { checkout } : {}),
    providers: entries,
    metadataEnvironment,
  }), { mode: 0o600 });

  return file;
}

/**
 * Проверяет факт запуска и код до разбора metadata.
 * Ошибка процесса сохраняет исходную диагностику в отчёте теста.
 */
export function cliJson(result, label = 'settings CLI') {
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);

  return JSON.parse(result.stdout);
}
