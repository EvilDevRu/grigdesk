import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activeRunnerReason,
  loadRunnerConfig,
  readRunnerAttempts,
  resolveRunnerState,
} from '../../server/src/lib/runner-state.js';

test('runner state follows engine precedence and exposes an emergency switch', () => {
  const profile = {
    PROJECT_RUNNER_PRIMARY: 'claude',
    PROJECT_RUNNER_FAILOVER: 'codex',
    STAGE_BUILD_PRIMARY: 'codex',
    STAGE_BUILD_FAILOVER: 'claude',
    MODEL_DEFAULT_CLAUDE_FAMILY: 'opus',
    MODEL_DEFAULT_CLAUDE_VERSION: 'latest',
    MODEL_DEFAULT_CODEX_FAMILY: 'sol',
  };
  const registry = {
    RUNNER_OVERRIDE_STAGE_BUILD: 'claude,codex',
    RUNNER_ACTUAL_BUILD: 'codex',
    MODEL_FAMILY_BUILD: 'gpt',
    MODEL_ACTUAL_BUILD: 'gpt-5.6-sol',
    RUNNER_REASON_BUILD: 'fallback_limit',
    PLAN_LEVEL_BUILD: 'native',
    CATALOG_REVISION_BUILD: '2026-07-29',
  };

  const state = resolveRunnerState(profile, registry, 'BUILD');
  assert.equal(state.primary, 'claude');
  assert.deepEqual(state.failover, ['codex']);
  assert.deepEqual(state.chain, ['claude', 'codex']);
  assert.equal(state.source, 'task-stage');
  assert.equal(state.actual, 'codex');
  assert.equal(state.family, 'gpt');
  assert.equal(state.model, 'gpt-5.6-sol');
  assert.equal(state.reason, 'fallback_limit');
  assert.equal(state.planLevel, 'native');
  assert.equal(state.catalogRevision, '2026-07-29');
  assert.equal(state.switched, true);
  assert.equal(state.models.claude.family, 'opus');
  assert.equal(state.models.codex.family, 'sol');
});

test('runner state falls back from stage policy to project policy', () => {
  const profile = {
    PROJECT_RUNNER_PRIMARY: 'codex',
    PROJECT_RUNNER_FAILOVER: 'claude,local',
    STAGE_REVIEW_PRIMARY: 'claude',
    STAGE_REVIEW_FAILOVER: 'codex',
  };
  assert.deepEqual(resolveRunnerState(profile, {}, 'REVIEW').chain, ['claude', 'codex']);
  assert.equal(resolveRunnerState(profile, {}, 'REVIEW').source, 'profile-stage');
  assert.deepEqual(resolveRunnerState(profile, {}, 'BUILD').chain, ['codex', 'claude', 'local']);
  assert.equal(resolveRunnerState(profile, {}, 'BUILD').source, 'profile-project');
});

test('active failover reason comes from completed primary attempt, not stale registry data', () => {
  const runner = {
    primary: 'claude',
    actual: 'codex',
    switched: true,
    reason: 'transient',
  };
  const attempts = [
    { runner: 'claude', result: 'limited' },
    { runner: 'codex', result: null },
  ];

  assert.equal(activeRunnerReason(runner, attempts), 'fallback_limit');
  assert.equal(activeRunnerReason(
    { ...runner, actual: 'claude', switched: false },
    attempts,
  ), 'transient');
});

test('runner config and attempts are read from canonical profile files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-runner-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  await mkdir(path.join(profilesDir, 'demo'), { recursive: true });
  await writeFile(path.join(profilesDir, 'demo', 'runners.env'), [
    'RUNNERS_SCHEMA=1',
    'CONFIG_REVISION=4',
    'PROJECT_RUNNER_PRIMARY=codex',
    'PROJECT_RUNNER_FAILOVER=claude',
    '',
  ].join('\n'));
  const runRoot = path.join(root, 'state', 'logs', 'runs', 't42', 'BUILD');
  await mkdir(path.join(runRoot, 'run-b'), { recursive: true });
  await mkdir(path.join(runRoot, 'run-a'), { recursive: true });
  await writeFile(path.join(runRoot, 'run-b', 'meta.env'), [
    'SCHEMA=1', 'RUNNER=codex', 'EPOCH=2', 'MODEL=gpt-5.6-sol',
    'RESULT_CLASS=ok', 'RC=0', 'SOURCE=runtime', '',
  ].join('\n'));
  await writeFile(path.join(runRoot, 'run-a', 'meta.env'), [
    'SCHEMA=1', 'RUNNER=claude', 'EPOCH=1', 'MODEL=opus',
    'RESULT_CLASS=limited', 'RC=1', 'SOURCE=runtime', '',
  ].join('\n'));

  assert.equal(loadRunnerConfig(profilesDir, 'demo').CONFIG_REVISION, '4');
  assert.deepEqual(await readRunnerAttempts(path.join(root, 'state'), '42', 'BUILD'), [
    { id: 'run-a', epoch: 1, runner: 'claude', model: 'opus', result: 'limited', rc: 1, source: 'runtime' },
    { id: 'run-b', epoch: 2, runner: 'codex', model: 'gpt-5.6-sol', result: 'ok', rc: 0, source: 'runtime' },
  ]);
});
