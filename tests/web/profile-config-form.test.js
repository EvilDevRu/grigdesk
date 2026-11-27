import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const form = await compileModule(webFile('src/views/projects/profileConfigForm.ts'));
const CONFIG = {
  profile: 'demo',
  variables: { profileSh: [], dashboard: [] },
  capabilities: [],
  runners: {
    PROJECT_RUNNER_PRIMARY: 'codex',
    PROJECT_RUNNER_FAILOVER: 'qwen-cli,deep_code,code',
    STAGE_REVIEW_SECOND_PRIMARY: 'qwen-cli',
    STAGE_REVIEW_SECOND_FAILOVER: 'codex',
    MODEL_REVIEW_SECOND_QWEN_CLI_EXACT: 'model-a',
    MODEL_REVIEW_SECOND_QWEN_CLI_EFFORT: 'high',
    MODEL_REVIEW_SECOND_QWEN_CLI_FAMILY_FAILOVER: 'backup',
    MODEL_REVIEW_DEEP_CODE_EXACT: 'ambiguous',
    MODEL_REVIEW_MISSING_EXACT: 'unknown',
    RUNNER_CODE_AUTH_PROFILE: 'local',
    CONFIG_REVISION: '9',
  },
};

test('RE-B3-05: stage/provider с подчёркиваниями разбираются только однозначно', () => {
  const model = form.configFormModel(CONFIG);
  const byKey = Object.fromEntries(model.rows.map((row) => [row.name, row]));

  assert.equal(byKey.STAGE_REVIEW_SECOND_PRIMARY?.editable, true);
  assert.equal(byKey.MODEL_REVIEW_SECOND_QWEN_CLI_EXACT?.editable, true);
  assert.equal(byKey.MODEL_REVIEW_DEEP_CODE_EXACT?.editable, false);
  assert.equal(byKey.MODEL_REVIEW_MISSING_EXACT?.editable, false);
  assert.equal(byKey.RUNNER_CODE_AUTH_PROFILE?.editable, false);
  assert.equal(byKey.CONFIG_REVISION?.editable, false);

  const plan = form.configSavePlan(CONFIG, {
    'r:STAGE_REVIEW_SECOND_PRIMARY': 'code',
    'r:MODEL_REVIEW_SECOND_QWEN_CLI_EXACT': 'model-b',
  });

  assert.deepEqual(plan.operations, [
    {
      kind: 'runner',
      role: 'REVIEW_SECOND',
      primary: 'code',
      failover: 'codex'
    },
    {
      kind: 'model',
      role: 'REVIEW_SECOND',
      provider: 'qwen-cli',
      exact: 'model-b',
      effort: 'high',
      familyFailover: 'backup'
    },
  ]);
  assert.equal(plan.summary.some((row) => row.name === 'STAGE_REVIEW_SECOND_FAILOVER'
    && row.before === 'codex' && row.after === 'codex'), true);
  assert.equal(plan.summary.some((row) => row.name.endsWith('_EFFORT')
    && row.before === 'high' && row.after === 'high'), true);

  const collision = structuredClone(CONFIG);


  collision.runners.PROJECT_RUNNER_FAILOVER += ',qwen_cli';
  assert.equal(form.configFormModel(collision).rows.find((row) =>
    row.name === 'MODEL_REVIEW_SECOND_QWEN_CLI_EXACT').editable, false);
});

test('профиль может установить отсутствующую скорость проекта и роли', () => {
  const config = structuredClone(CONFIG);

  config.runners.MODEL_REVIEW_SECOND_CODEX_EXACT = 'sol';

  const key = 'MODEL_REVIEW_SECOND_CODEX_SPEED';
  const fallback = 'MODEL_DEFAULT_CODEX_SPEED';
  const rows = form.configFormModel(config).rows;

  assert.equal(rows.find((row) => row.name === key)?.value, null);
  assert.equal(rows.find((row) => row.name === fallback)?.editable, true);
  assert.equal(rows.find((row) => row.name === 'MODEL_DEFAULT_QWEN_CLI_SPEED'), undefined);
  assert.equal(rows.find((row) => row.name === 'MODEL_DEFAULT_CLAUDE_SPEED'), undefined);
  assert.equal(rows.find((row) => row.name === 'MODEL_REVIEW_SECOND_QWEN_CLI_SPEED'), undefined);
  config.runners.MODEL_REVIEW_SECOND_QWEN_CLI_SPEED = 'fast';

  const stale = form.configFormModel(config).rows.find((row) =>
    row.name === 'MODEL_REVIEW_SECOND_QWEN_CLI_SPEED');

  assert.equal(stale?.speedModes, undefined);
  assert.equal(stale?.value, 'fast');

  const save = form.configSavePlan(config, {
    [`r:${key}`]: 'standard',
    [`r:${fallback}`]: 'fast',
  });

  assert.deepEqual(save.blocked, []);
  assert.ok(save.operations.some((item) => item.role === 'REVIEW_SECOND' && item.speed === 'standard'));
  assert.ok(save.operations.some((item) => item.role === 'DEFAULT' && item.speed === 'fast'));
  config.runners[key] = 'fast';
  assert.equal(form.configSavePlan(config, { [`r:${key}`]: '' }).operations[0]?.speed, '');
  assert.deepEqual(form.configSavePlan(config, { 'r:MODEL_REVIEW_SECOND_CODEX_EXACT': 'next' })
    .operations.find((item) => item.role === 'REVIEW_SECOND'), {
    kind: 'model',
    role: 'REVIEW_SECOND',
    provider: 'codex',
    exact: 'next',
  });
});

test('Codex и Claude учитываются при разборе модельных ключей вне цепочки', () => {
  const config = structuredClone(CONFIG);
  const ambiguous = 'MODEL_PLAN_TEAM_CLAUDE_SPEED';
  const unique = 'MODEL_REVIEW_CLAUDE_EXACT';
  const synthetic = 'MODEL_REVIEW_CLAUDE_SPEED';

  config.runners.STAGE_PLAN_PRIMARY = 'team_claude';
  config.runners[ambiguous] = 'fast';
  config.runners[unique] = 'opus-exact';

  const rows = form.configFormModel(config).rows;
  const clear = form.configSavePlan(config, { [`r:${ambiguous}`]: '' });

  assert.equal(rows.find((row) => row.name === ambiguous)?.editable, false);
  assert.deepEqual(clear.blocked, [`r:${ambiguous}`]);
  assert.deepEqual(clear.operations, []);
  assert.equal(rows.find((row) => row.name === unique)?.editable, true);
  assert.deepEqual(rows.find((row) => row.name === synthetic)?.speedModes, ['standard', 'fast']);
});

test('RE-B3-06: reconciliation снимает применённое и хранит неприменённое/исчезнувшее', () => {
  const edits = {
    'r:PROJECT_RUNNER_PRIMARY': 'codex',
    'r:MODEL_REVIEW_SECOND_QWEN_CLI_EXACT': 'model-b',
    'r:REMOVED': 'keep-me',
  };
  const kept = form.reconcileConfigEdits(CONFIG, edits);

  assert.deepEqual(kept, {
    'r:MODEL_REVIEW_SECOND_QWEN_CLI_EXACT': 'model-b',
    'r:REMOVED': 'keep-me',
  });
  assert.deepEqual(form.configSavePlan(CONFIG, kept).blocked, ['r:REMOVED']);
});

test('RE-B3-10: editable отсутствующая переменная создаётся с from:null', () => {
  const config = structuredClone(CONFIG);


  config.variables.profileSh = [{
    name: 'PROFILE_CTX',
    value: null,
    literal: false,
    editable: true,
    present: false,
    reason: 'not_declared',
  }];


  const plan = form.configSavePlan(config, { 'v:profile.sh:PROFILE_CTX': 'new context' });

  assert.deepEqual(plan.variables, [{
    file: 'profile.sh', changes: [{
      name: 'PROFILE_CTX',
      from: null,
      to: 'new context'
    }],
  }]);
  assert.deepEqual(plan.blocked, []);
});
