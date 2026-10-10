import assert from 'node:assert/strict';
import test from 'node:test';

import { readConfig } from '../../relay/src/config.ts';
import { makeCert, temporary } from './helpers.js';

test('RL-01…RL-03: конфигурация проверяет секреты и ограничивает числовые параметры', async (t) => {
  const directory = await temporary(t);
  const cert = await makeCert(directory, 'relay-config');
  const env = {
    RELAY_TLS_KEY_B64: Buffer.from(cert.keyPem).toString('base64'),
    RELAY_TLS_CERT_B64: Buffer.from(cert.certPem).toString('base64'),
    RELAY_BRAIN_TOKEN_SHA256: 'a'.repeat(64),
    RELAY_DEVICE_TOKEN_SHA256: 'b'.repeat(64),
  };

  for (const name of Object.keys(env)) {
    const missing = { ...env };

    delete missing[name];
    assert.throws(() => readConfig(missing), new RegExp(name));
  }

  assert.throws(() =>
    readConfig({
      ...env,
      RELAY_BRAIN_TOKEN_SHA256: 'wrong',
    }),
  );
  assert.throws(() =>
    readConfig({
      ...env,
      RELAY_TLS_KEY_B64: 'YQ==',
    }),
  );
  assert.throws(() =>
    readConfig({
      ...env,
      RELAY_MAX_CONNECTIONS: 'Infinity',
    }),
  );
  assert.throws(() =>
    readConfig({
      ...env,
      RELAY_MAX_CONNECTIONS: '10000000',
    }),
  );
  assert.throws(() =>
    readConfig({
      ...env,
      RELAY_HELLO_TIMEOUT_MS: '0',
    }),
  );

  const config = readConfig(env);

  assert.equal(config.port, 7443);
  assert.equal(config.helloTimeoutMs, 5000);
  assert.equal(config.brainTimeoutMs, 10000);
  assert.equal(config.maxConnections, 256);
  assert.equal(config.maxPerIp, 32);
  assert.equal(config.maxPending, 32);
  assert.equal(config.idleMs, 1800000);
  assert.equal(config.watchdogMs, 10000);
  assert.equal(
    readConfig({
      ...env,
      RELAY_MAX_PENDING: '2',
    }).maxPending,
    2,
  );
});
