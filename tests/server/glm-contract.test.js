import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GLM_MODEL_ERROR_CODES,
  GLM_NATIVE_TOOLS,
  GLM_POLICY_REVISION,
  GLM_PROFILE_REVISION,
  buildGlmRoute,
  glmCompatibilityIdentity,
  parseGlmAccessMode,
  selectGlmServiceKey,
} from '../../server/src/lib/glm/contract.ts';

test('режимы доступа — только api и coding-plan, остальное отвергается', () => {
  assert.equal(parseGlmAccessMode('api'), 'api');
  assert.equal(parseGlmAccessMode('coding-plan'), 'coding-plan');

  for (const value of [undefined, null, '', 'API', ' api', 'deepseek', {}, 1]) {
    assert.equal(parseGlmAccessMode(value), null);
  }
});

test('маршрут coding-plan не задаёт baseURL, маршрут api задаёт https://api.z.ai/api/paas/v4', () => {
  assert.equal(Object.hasOwn(buildGlmRoute('coding-plan'), 'baseURL'), false);
  assert.equal(buildGlmRoute('api').baseURL, 'https://api.z.ai/api/paas/v4');
});

test('маршрут задаёт apiKeyEnv GRIGDESK_GLM_ROUTE_KEY и retryPolicy normal с maxRetries 10', () => {
  for (const mode of ['api', 'coding-plan']) {
    const route = buildGlmRoute(mode);

    assert.equal(route.apiKeyEnv, 'GRIGDESK_GLM_ROUTE_KEY');
    // Повторяются только транзиентные коды dsh-llm-retry по умолчанию: обрыв, 429, 5xx, таймаут.
    assert.deepEqual(route.retryPolicy, { mode: 'normal', maxRetries: 10 });
  }
});



/**
 * Синтетический descriptor содержит ровно проверяемые входы допуска.
 * Дополнительные поля имитируют перенос и другую платформу сборки.
 */
function runtimeFixture() {
  return {
    source: { commit: 'synthetic-upstream-commit' },
    inputIdentity: {
      composition: 'grigdesk-host-web-acp-v3',
      dependencyLock: 'build-lock-hash',
    },
    llmPiAi: {
      piAi: {
        version: '0.85.1',
        integrity: 'sha512-synthetic-pi-ai',
      },
      sourceHash: 'plugin-source-hash',
      patches: [{ path: 'host.patch', sha256: 'patch-hash' }],
    },
    buildId: 'build-one',
    platform: 'linux',
    generationDir: '/synthetic/generation',
  };
}

test('glmCompatibilityIdentity меняется от каждого входа Р9'
  + ' и не зависит от buildId, платформы и пути generation',
  () => {
    const original = runtimeFixture();
    const identity = glmCompatibilityIdentity(original, 'api');
    const changes = [
      (value) => {
        value.source.commit += '-changed';
      },
      (value) => {
        value.inputIdentity.composition += '-changed';
      },
      (value) => {
        value.inputIdentity.dependencyLock += '-changed';
      },
      (value) => {
        value.llmPiAi.piAi.version += '-changed';
      },
      (value) => {
        value.llmPiAi.piAi.integrity += '-changed';
      },
      (value) => {
        value.llmPiAi.sourceHash += '-changed';
      },
      (value) => {
        value.llmPiAi.patches[0].sha256 += '-changed';
      },
    ];

    assert.match(identity, /^[a-f0-9]{64}$/u);

    for (const change of changes) {
      const changed = structuredClone(original);

      change(changed);
      assert.notEqual(glmCompatibilityIdentity(changed, 'api'), identity);
    }

    for (const revisions of [
      { profile: `${GLM_PROFILE_REVISION}-changed`, policy: GLM_POLICY_REVISION },
      { profile: GLM_PROFILE_REVISION, policy: `${GLM_POLICY_REVISION}-changed` },
    ]) {
      assert.notEqual(glmCompatibilityIdentity(original, 'api', revisions), identity);
    }

    assert.notEqual(glmCompatibilityIdentity(original, 'coding-plan'), identity);
    assert.equal(glmCompatibilityIdentity({
      ...original,
      buildId: 'another-build',
      platform: 'darwin',
      generationDir: '/different/generation',
    }, 'api'), identity);
    assert.equal(glmCompatibilityIdentity({
      ...original,
      inputIdentity: {
        dependencyLock: original.inputIdentity.dependencyLock,
        composition: original.inputIdentity.composition,
      },
    }, 'api'), identity);
  });

test('ключ службы выбирается только по своему режиму: api — ZAI_API_KEY, coding-plan — ZAI_CODING_API_KEY',
  () => {
    const env = {
      ZAI_API_KEY: 'synthetic-api',
      ZAI_CODING_API_KEY: 'synthetic-coding',
      DEEPSEEK_API_KEY: 'synthetic-other',
    };

    assert.equal(selectGlmServiceKey('api', env), 'synthetic-api');
    assert.equal(selectGlmServiceKey('coding-plan', env), 'synthetic-coding');
    assert.equal(selectGlmServiceKey('api', { ...env, ZAI_API_KEY: undefined }), null);
    assert.equal(selectGlmServiceKey('coding-plan', { ...env, ZAI_CODING_API_KEY: undefined }), null);
    assert.equal(selectGlmServiceKey('api', { ...env, ZAI_API_KEY: '' }), null);
    assert.equal(selectGlmServiceKey('coding-plan', { ...env, ZAI_CODING_API_KEY: '' }), null);
  });

// Полный список инструментов web-профиля GLM из запроса настоящей generation (факт G2, F5).
const PROFILE_TOOLS = [
  'ask_user_question', 'bash', 'create_goal', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep',
  'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'present', 'ralph', 'read',
  'read_image', 'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal',
  'web_fetch', 'web_search', 'workflow', 'write',
];

const NATIVE_TOOLS_TEST = 'GLM_NATIVE_TOOLS — точные имена профиля без делегирующих, workflow и web, '
  + 'но с вопросом агента, навыками и фоновыми задачами';

test(NATIVE_TOOLS_TEST, () => {
  const forbidden = [
    'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph',
    'web_fetch', 'web_search', 'exit_plan_mode', 'create_goal',
    'get_goal', 'update_goal', 'present', 'read_image',
  ];

  assert.equal(Object.isFrozen(GLM_NATIVE_TOOLS), true);
  assert.ok(GLM_NATIVE_TOOLS.includes('ask_user_question'));
  assert.ok(GLM_NATIVE_TOOLS.includes('skill'));
  assert.ok(GLM_NATIVE_TOOLS.every((name) => PROFILE_TOOLS.includes(name)));
  assert.deepEqual(GLM_NATIVE_TOOLS.filter((name) => forbidden.includes(name)), []);
  assert.deepEqual([...GLM_NATIVE_TOOLS].sort(), ['ask_user_question', 'bash', 'edit', 'glob', 'grep',
    'job_kill', 'job_list', 'job_output', 'read', 'skill', 'todo_write', 'write']);
});

test('коды ошибки модели в turn/end: AUTH и QUOTA отличаются от доставки', () => {
  assert.deepEqual(GLM_MODEL_ERROR_CODES, {
    AUTH: 'glm_auth_failed',
    QUOTA: 'glm_quota_exhausted',
  });
  assert.equal(Object.isFrozen(GLM_MODEL_ERROR_CODES), true);
});
