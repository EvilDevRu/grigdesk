import assert from 'node:assert/strict';
import test from 'node:test';

import { readSettings } from '../../cli/commands.ts';
import { resolveRuntimeSettings } from '../../shared/runtime/runtimeSettings.ts';
import type { RuntimeSettingsInput } from '../../shared/runtime/runtimeSettings.ts';

const HOME = '/home/user';

test('BR-01: runtimeSettings сохраняет defaults и все поля grigdesk-ctl status', () => {
  assert.deepEqual(resolveRuntimeSettings({
    env: {},
    file: {},
    home: HOME,
  }), {
    port: 8140,
    origin: 'http://127.0.0.1:8140',
    windowKeyPath: null,
    relayProject: null,
    cliTokenPath: '/home/user/.grigdesk/state/cli-token',
  });
  assert.deepEqual(resolveRuntimeSettings({
    env: { GRIGDESK_HOME: '/data/c/' },
    file: {
      GRIGDESK_PORT: '8123',
      GRIGDESK_WINDOW_KEY_PATH: '/run/key',
      GRIGDESK_RELAY_PROJECT: 'relay-home',
    },
    home: HOME,
  }), {
    port: 8123,
    origin: 'http://127.0.0.1:8123',
    windowKeyPath: '/run/key',
    relayProject: 'relay-home',
    cliTokenPath: '/data/c/state/cli-token',
  });
});

test('BR-02: env имеет приоритет над файлом, включая пустое значение', () => {
  const resolve = (env: Record<string, string>, file: Record<string, string>) => resolveRuntimeSettings({
    env,
    file,
    home: HOME,
  });

  assert.equal(resolve({ GRIGDESK_PORT: '8181' }, { GRIGDESK_PORT: '8123' }).port, 8181);
  assert.equal(resolve({ GRIGDESK_PORT: '' }, { GRIGDESK_PORT: '8123' }).port, 8140);

  for (const value of ['0', 'abc', '']) {
    assert.equal(resolve({}, { GRIGDESK_PORT: value }).port, 8140, value);
  }

  const standard = '/home/user/.grigdesk/state/cli-token';

  assert.equal(resolve({ GRIGDESK_CLI_TOKEN_PATH: '/env-token' }, { GRIGDESK_CLI_TOKEN_PATH: '/file-token' })
    .cliTokenPath, '/env-token');
  assert.equal(resolve({ GRIGDESK_CLI_TOKEN_PATH: '' }, { GRIGDESK_CLI_TOKEN_PATH: '/file-token' })
    .cliTokenPath, standard);
  assert.equal(resolve({}, { GRIGDESK_CLI_TOKEN_PATH: '' }).cliTokenPath, standard);
});

test('BR-03: ключи выбора файла запрещены даже пустыми', () => {
  for (const key of ['GRIGDESK_HOME', 'GRIGDESK_ENV_FILE']) {
    for (const value of ['/other', '']) {
      assert.throws(() => resolveRuntimeSettings({
        env: {},
        file: { [key]: value },
        home: HOME,
      }), new RegExp(`Ключ ${key} запрещён в файле настроек\\.`));
    }
  }
});

test('BR-04: legacyTokenPath используется только по явному аргументу', () => {
  const legacy = '/code/server/.state/cli-token';

  assert.equal(resolveRuntimeSettings({
    env: { HOME },
    file: {},
    home: HOME,
  }).cliTokenPath, '/home/user/.grigdesk/state/cli-token');
  assert.equal(resolveRuntimeSettings({
    env: { HOME },
    file: {},
    home: HOME,
    legacyTokenPath: legacy,
  }).cliTokenPath, legacy);

  for (const [envFile, legacyPath] of [[null, undefined], [null, legacy], ['GRIGDESK_PORT=8123', legacy],
    ['GRIGDESK_CLI_TOKEN_PATH=/file-token', legacy]] as const) {
    const env = { HOME };

    assert.deepEqual(readSettings('/example', env, envFile, legacyPath), resolveRuntimeSettings({
      env,
      file: envFile === null ? {} : Object.fromEntries([envFile.split('=') as [string, string]]),
      home: HOME,
      legacyTokenPath: legacyPath,
    }));
  }
});

test('BR-05: общий resolver не мутирует входы', () => {
  const env = Object.freeze({
    HOME,
    GRIGDESK_PORT: '8181',
  });
  const file = Object.freeze({ GRIGDESK_RELAY_PROJECT: 'relay' });
  const input: RuntimeSettingsInput = Object.freeze({
    env,
    file,
    home: HOME,
  });

  assert.equal(resolveRuntimeSettings(input).port, 8181);
  assert.deepEqual(env, {
    HOME,
    GRIGDESK_PORT: '8181',
  });
  assert.deepEqual(file, { GRIGDESK_RELAY_PROJECT: 'relay' });
});

test('BR-06: явный путь токена не требует верной папки данных', () => {
  const settings = resolveRuntimeSettings({
    env: {
      GRIGDESK_HOME: 'bad path',
      GRIGDESK_CLI_TOKEN_PATH: '/token/file',
    },
    file: {},
    home: '/home/user',
  });

  assert.equal(settings.cliTokenPath, '/token/file');
  assert.throws(() => resolveRuntimeSettings({
    env: { GRIGDESK_HOME: 'bad path' },
    file: {},
    home: '/home/user',
  }), /GRIGDESK_HOME/);
});
