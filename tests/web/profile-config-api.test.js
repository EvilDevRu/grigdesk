import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

test('RE-B3-04: клиент передаёт точные пути и тела и разбирает ответ', async (t) => {
  const calls = [];
  const variable = {
    name: 'PROFILE_CTX',
    value: 'a',
    literal: true,
    editable: true,
    present: true,
    reason: null,
  };
  const config = {
    profile: 'demo',
    variables: { profileSh: [variable], dashboard: [] },
    runners: { PROJECT_RUNNER_PRIMARY: 'codex' },
    capabilities: ['route-v2'],
  };

  globalThis.__profileConfigApiHarness = {
    get: async (url) => {
      calls.push(['GET', url]);

      return config;
    },
    patch: async (url, body) => {
      calls.push(['PATCH', url, body]);

      return url.endsWith('/variables')
        ? { variables: [variable] } : { runners: config.runners };
    },
  };
  t.after(() => {
    delete globalThis.__profileConfigApiHarness;
  });

  const client = await compileModule(webFile('src/shared/profileConfigApi.ts'), {
    stubs: { './apiClient.ts': `
export const api = {
  get: (...args) => globalThis.__profileConfigApiHarness.get(...args),
  patch: (...args) => globalThis.__profileConfigApiHarness.patch(...args),
};` },
  });
  const changes = [{
    name: 'PROFILE_CTX',
    from: 'a',
    to: 'b'
  }];
  const operations = [{
    kind: 'runner',
    primary: 'qwen',
    failover: 'claude'
  }];
  const actual = await client.fetchProfileConfig('demo');
  const variables = await client.patchProfileVariables('demo', 'profile.sh', changes);
  const runners = await client.patchProfileRunners('demo', operations);

  assert.deepEqual(calls, [
    ['GET', '/api/profiles/demo/config'],
    ['PATCH', '/api/profiles/demo/variables', { file: 'profile.sh', changes }],
    ['PATCH', '/api/profiles/demo/runners', { operations }],
  ]);
  assert.deepEqual(actual, config);
  assert.deepEqual(variables, [variable]);
  assert.deepEqual(runners, config.runners);

  globalThis.__profileConfigApiHarness.get = async () => ({ ...config, profile: 'other' });
  await assert.rejects(() => client.fetchProfileConfig('demo'));
});
