import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { config } from '../../server/src/config.ts';
import { buildDeepSeekChildEnv } from '../../server/src/lib/deepseek/env.ts';
import {
  assertGlmRuntimeHome,
  buildGlmChildEnv,
  glmAuthProfileId,
  resolveGlmAccess,
} from '../../server/src/lib/glm/env.ts';

const ADMITTED = [{ mode: 'api', compatibility: 'synthetic' }];
const SYSTEM = {
  PATH: '/usr/bin',
  HOME: '/home/test',
  LANG: 'ru_RU.UTF-8',
  TZ: 'Asia/Novosibirsk',
  TMPDIR: '/tmp/synthetic',
};
const FOREIGN = {
  ZAI_API_KEY: 'synthetic-zai-api',
  ZAI_CODING_API_KEY: 'synthetic-zai-coding',
  ZAI_CODING_CN_API_KEY: 'synthetic-zai-cn',
  DEEPSEEK_API_KEY: 'synthetic-deepseek',
  OPENAI_API_KEY: 'synthetic-openai',
  ANTHROPIC_API_KEY: 'synthetic-anthropic',
  HTTPS_PROXY: 'http://proxy.invalid',
  GRIGDESK_PROVIDER_PREFS_PATH: '/private-prefs',
};

test('без GRIGDESK_GLM_API_MODE причина glm_access_mode_missing', () => {
  for (const mode of [undefined, '']) {
    const access = resolveGlmAccess({
      env: { ...FOREIGN, GRIGDESK_GLM_API_MODE: mode },
      admission: ADMITTED,
    });

    assert.deepEqual(access, { mode: null, reason: 'glm_access_mode_missing' });
  }
});

test('GRIGDESK_GLM_API_MODE вне списка — glm_access_mode_invalid', () => {
  for (const mode of ['API', 'coding', 'bigmodel', ' api']) {
    const access = resolveGlmAccess({
      env: { ...FOREIGN, GRIGDESK_GLM_API_MODE: mode },
      admission: ADMITTED,
    });

    assert.deepEqual(access, { mode: null, reason: 'glm_access_mode_invalid' });
  }
});

const API_KEY_TEST = 'режим api без ZAI_API_KEY даёт glm_key_missing '
  + 'и не берёт ZAI_CODING_API_KEY или DEEPSEEK_API_KEY';

test(API_KEY_TEST, () => {
  const env = {
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_CODING_API_KEY: 'synthetic-zai-coding',
    DEEPSEEK_API_KEY: 'synthetic-deepseek',
  };

  assert.deepEqual(resolveGlmAccess({ env, admission: ADMITTED }), {
    mode: 'api',
    reason: 'glm_key_missing',
  });
  assert.throws(() => buildGlmChildEnv({
    source: env,
    dshHome: '/state/home',
    mode: 'api',
  }), {
    code: 'glm_key_missing',
  });
});

test('режим coding-plan без ZAI_CODING_API_KEY даёт glm_key_missing и не берёт ZAI_API_KEY', () => {
  const env = {
    GRIGDESK_GLM_API_MODE: 'coding-plan',
    ZAI_API_KEY: 'synthetic-zai-api',
  };

  assert.deepEqual(resolveGlmAccess({
    env,
    admission: [{ mode: 'coding-plan', compatibility: 'synthetic' }],
  }), {
    mode: 'coding-plan',
    reason: 'glm_key_missing',
  });
  assert.throws(() => buildGlmChildEnv({
    source: env,
    dshHome: '/state/home',
    mode: 'coding-plan',
  }), {
    code: 'glm_key_missing',
  });
});

test('режим не из GLM_ADMISSION с ключом даёт glm_mode_not_admitted', () => {
  const env = {
    GRIGDESK_GLM_API_MODE: 'coding-plan',
    ZAI_CODING_API_KEY: 'synthetic-zai-coding',
  };

  assert.deepEqual(resolveGlmAccess({ env, admission: ADMITTED }), {
    mode: 'coding-plan',
    reason: 'glm_mode_not_admitted',
  });
  assert.deepEqual(resolveGlmAccess({ env, admission: [] }), {
    mode: 'coding-plan',
    reason: 'glm_mode_not_admitted',
  });
  assert.deepEqual(resolveGlmAccess({
    env: { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: 'synthetic-zai-api' },
    admission: ADMITTED,
  }), {
    mode: 'api',
    reason: null,
  });
});

test('окружение процесса GLM — только allowlist и GRIGDESK_GLM_ROUTE_KEY', () => {
  for (const [mode, key] of [['api', 'synthetic-zai-api'], ['coding-plan', 'synthetic-zai-coding']]) {
    const env = buildGlmChildEnv({
      source: { ...SYSTEM, ...FOREIGN },
      dshHome: '/state/glm/home',
      mode,
    });

    assert.deepEqual(env, {
      ...SYSTEM,
      DSH_HOME: '/state/glm/home',
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
      GRIGDESK_GLM_ROUTE_KEY: key,
    });
  }
});

test('окружение процесса DeepSeek не содержит ZAI_API_KEY и ZAI_CODING_API_KEY', () => {
  const env = buildDeepSeekChildEnv({
    source: { ...SYSTEM, ...FOREIGN },
    dshHome: '/state/deepseek/home',
  });

  assert.equal(env.DEEPSEEK_API_KEY, 'synthetic-deepseek');

  const foreign = ['ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'ZAI_CODING_CN_API_KEY', 'GRIGDESK_GLM_ROUTE_KEY'];

  for (const name of foreign) {
    assert.equal(Object.hasOwn(env, name), false, name);
  }
});

test('относительный GRIGDESK_GLM_RUNTIME_HOME — отказ, по умолчанию корень внутри config.stateDir', () => {
  for (const value of ['relative/home', './home', '', 'home\0x']) {
    assert.throws(() => assertGlmRuntimeHome(value), { code: 'glm_runtime_home_invalid' });
  }

  const relative = path.relative(config.stateDir, assertGlmRuntimeHome(config.glmRuntimeHome));

  assert.equal(config.glmRuntimeHome, path.join(config.stateDir, 'grigdesk-glm'));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(assertGlmRuntimeHome('/srv/glm'), '/srv/glm');
});

test('отпечаток auth меняется от ключа и режима и не содержит ключа', () => {
  const key = 'synthetic-binding-key';
  const api = glmAuthProfileId('api', key);

  assert.match(api, /^glm-env-key:[a-f0-9]{16}$/u);
  assert.equal(api.includes(key), false);
  assert.notEqual(api, glmAuthProfileId('coding-plan', key));
  assert.notEqual(api, glmAuthProfileId('api', `${key}-other`));
  assert.equal(api, glmAuthProfileId('api', key));
});
