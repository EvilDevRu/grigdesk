import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createRelayCredentials,
  ensureBrainIdentity,
  fingerprintOf,
  renderRelayEnv,
} from '../../server/src/lib/mobile/identity.ts';
import { readConfig } from '../../relay/src/config.ts';
import { temporary } from '../relay/helpers.js';

test('MB-01…MB-04: постоянная личность, приватные файлы и совместимый relay.env без токенов', async (t) => {
  const directory = await temporary(t);
  const brain = await ensureBrainIdentity(directory);
  const again = await ensureBrainIdentity(directory);

  assert.equal(brain.fp, again.fp);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, 'brain-key.pem'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, 'brain-cert.pem'))).mode & 0o777, 0o600);
  assert.equal(fingerprintOf(brain.certPem), brain.fp);
  assert.equal(brain.fp.length, 64);

  const relay = await createRelayCredentials(directory, 'r12345678');

  assert.equal(Buffer.from(relay.brainToken, 'base64url').length, 32);
  assert.equal(Buffer.from(relay.deviceToken, 'base64url').length, 32);
  assert.equal(new X509Certificate(relay.certPem).checkPrivateKey(relay.privateKey), true);

  const rendered = renderRelayEnv(relay);

  assert.equal(rendered.includes(relay.brainToken), false);
  assert.equal(rendered.includes(relay.deviceToken), false);

  const env = Object.fromEntries(
    rendered
      .trim()
      .split('\n')
      .map((line) => {
        const position = line.indexOf('=');

        return [line.slice(0, position), line.slice(position + 1)];
      }),
  );

  assert.equal(readConfig(env).cert, relay.certPem);
  assert.equal(
    env.RELAY_BRAIN_TOKEN_SHA256,
    createHash('sha256').update(relay.brainToken).digest('hex'),
  );
  await assert.rejects(() => createRelayCredentials(directory, '../other'));
});
