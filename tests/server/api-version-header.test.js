import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthStore } from '../../server/src/lib/authStore.ts';
import apiVersionPlugin from '../../server/src/plugins/apiVersion.ts';
import authPlugin from '../../server/src/plugins/auth.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('API: заголовок 0.1 есть у открытого ответа, отказа гарда и 404', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-api-header-'));
  const app = Fastify();
  const authStore = new AuthStore({
    legacyAccountPath: path.join(root, 'account.json'),
    sessionsPath: path.join(root, 'sessions.json'),
  });

  t.after(async () => {
    await app.close();
    await rm(root, {
      recursive: true,
      force: true,
    });
  });
  await app.register(apiVersionPlugin);
  await app.register(authPlugin, { authStore });
  app.get('/api/auth/state', async () => ({ authenticated: false }));
  app.get('/api/private', async () => ({ secret: true }));

  for (const [url, status] of [
    ['/api/auth/state', 200],
    ['/api/private', 401],
    ['/missing', 404],
  ]) {
    const response = await app.inject(url);

    assert.equal(response.statusCode, status);
    assert.equal(response.headers['x-grigdesk-api'], '0.1', `${url}: версия ответа`);
  }
});
