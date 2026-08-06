import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, rm, stat, utimes, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activeRunnerReason,
  loadRunnerConfig,
  readRunnerAttempts,
  readRunnerWorkTime,
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
    MODEL_DEFAULT_CLAUDE_EFFORT: 'max',
    MODEL_DEFAULT_CODEX_FAMILY: 'sol',
    MODEL_DEFAULT_CODEX_EFFORT: 'xhigh',
    MODEL_BUILD_CODEX_EFFORT: 'ultra',
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
  assert.equal(state.models.claude.effort, 'max');
  assert.equal(state.models.codex.family, 'sol');
  assert.equal(state.models.codex.effort, 'ultra');
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
    { runner: 'codex', reason: null, result: null },
  ];

  assert.equal(activeRunnerReason(runner, attempts), 'fallback_limit');
  assert.equal(activeRunnerReason(runner, [
    { runner: 'claude', result: 'limited' },
    { runner: 'codex', result: 'ok' },
    { runner: 'codex', reason: 'fallback_limit', result: null },
  ]), 'fallback_limit', 'a retry on the reserve keeps the original switch reason');
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
    'EFFORT=ultra',
    'ROUTE_REASON=fallback_limit',
    'RESULT_CLASS=ok', 'RC=0', 'SOURCE=runtime', '',
  ].join('\n'));
  await writeFile(path.join(runRoot, 'run-a', 'meta.env'), [
    'SCHEMA=1', 'RUNNER=claude', 'EPOCH=1', 'MODEL=opus',
    'RESULT_CLASS=limited', 'RC=1', 'SOURCE=runtime', '',
  ].join('\n'));

  assert.equal(loadRunnerConfig(profilesDir, 'demo').CONFIG_REVISION, '4');
  assert.deepEqual(await readRunnerAttempts(path.join(root, 'state'), '42', 'BUILD'), [
    {
      id: 'run-a', epoch: 1, runner: 'claude', model: 'opus', reason: null,
      effort: null, result: 'limited', rc: 1, source: 'runtime',
    },
    {
      id: 'run-b', epoch: 2, runner: 'codex', model: 'gpt-5.6-sol',
      effort: 'ultra', reason: 'fallback_limit', result: 'ok', rc: 0, source: 'runtime',
    },
  ]);
});

test('runner work time sums process spans instead of gaps between route events', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-runner-work-time-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');

  async function completed(stage, id, durationMs) {
    const runDir = path.join(stateDir, 'logs', 'runs', 't8164', stage, id);
    await mkdir(runDir, { recursive: true });
    const meta = path.join(runDir, 'meta.env');
    await writeFile(meta, [
      'SCHEMA=1', 'TASK=8164', `STAGE=${stage}`, `RUN_ID=${id}`,
      'RESULT_CLASS=ok', 'RC=0', '',
    ].join('\n'));
    const started = (await stat(runDir)).birthtimeMs;
    const finished = new Date(Math.ceil(started / 1000) * 1000 + durationMs);
    await utimes(meta, finished, finished);
    return (await stat(meta)).mtimeMs - started;
  }

  const buildMs = await completed('BUILD', 'run-build', 5 * 60 * 1000);
  const lintMs = await completed('LINT', 'run-lint', 3 * 60 * 1000);
  // Scout и календарная пауза между двумя route events в этот счётчик не входят.
  await completed('SCOUT', 'run-scout', 60 * 60 * 1000);
  const activeDir = path.join(
    stateDir, 'logs', 'runs', 't8164', 'REVIEW', 'run-review-active',
  );
  await mkdir(activeDir, { recursive: true });
  const activeStarted = (await stat(activeDir)).birthtimeMs;

  assert.deepEqual(await readRunnerWorkTime(
    stateDir,
    '8164',
    ['BUILD', 'LINT', 'REVIEW'],
    {
      sinceMs: activeStarted - 60_000,
      activeRuns: { REVIEW: 'run-review-active' },
    },
  ), {
    workSec: Math.floor((buildMs + lintMs) / 1000),
    runningSinceMs: activeStarted,
    completedRuns: 2,
  });
  assert.equal(await readRunnerWorkTime(
    stateDir,
    '8164',
    ['BUILD', 'LINT'],
    { sinceMs: Date.now() + 60_000 },
  ), null, 'run-каталоги предыдущей attempt не попадают в новый счётчик');
});
