import assert from 'node:assert/strict';
import test from 'node:test';

import { buildServerEnv } from '../../desktop/src/runtimeConfig.ts';
import { packagedChildEnvironment } from '../../shared/node/packagedEnvironment.ts';

test('parent protocol сохраняет исходный PATH/prefix до desktop и повторного packaged bootstrap', () => {
  const parent = {
    PATH: '/custom/bin:/usr/bin:/bin',
    NPM_CONFIG_PREFIX: '/custom/npm',
    PRIVATE_API_TOKEN: 'не переносить в протокол',
  };
  const first = buildServerEnv({
    parent,
    dotenv: {},
    node: '/R/runtime/node/bin/node',
    home: '/fixture/home',
    sea: true,
  });

  assert.equal(typeof first.GRIGDESK_USER_CLI_PARENT_V1, 'string');
  assert.deepEqual(JSON.parse(first.GRIGDESK_USER_CLI_PARENT_V1), {
    version: 1,
    path: parent.PATH,
    npmPrefixLower: null,
    npmPrefixUpper: '/custom/npm',
  });

  const second = packagedChildEnvironment({
    env: first,
    node: '/R/runtime/node/bin/node',
    home: '/fixture',
  });

  assert.equal(second.GRIGDESK_USER_CLI_PARENT_V1, first.GRIGDESK_USER_CLI_PARENT_V1);
  assert.equal(second.npm_config_prefix, '/custom/npm');
  assert.equal(parent.NPM_CONFIG_PREFIX, '/custom/npm');
});

test('source desktop также сохраняет оригинал до добавления каталогов CLI', () => {
  const env = buildServerEnv({
    parent: { PATH: '/usr/bin:/bin' },
    dotenv: {},
    node: '/node/bin/node',
    home: '/fixture',
  });

  assert.equal(typeof env.GRIGDESK_USER_CLI_PARENT_V1, 'string');
  assert.equal(JSON.parse(env.GRIGDESK_USER_CLI_PARENT_V1).path, '/usr/bin:/bin');
});
