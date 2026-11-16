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
