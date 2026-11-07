import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileHelpSources } from '../../shared/node/helpSources.ts';
import { createHelpService } from '../../server/src/lib/help/service.ts';
import helpModule from '../../server/src/modules/help/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { AuthStore } from '../../server/src/lib/authStore.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('HELP-API1: настоящий auth, один load, безопасная ошибка и повтор', async (t) => {
  const corpus = await compileHelpSources(path.resolve(import.meta.dirname, '../..'), {
    version: '0.1.0', commit: 'source'
  });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'help-auth-'));
  const authStore = new AuthStore({
    legacyAccountPath: path.join(temporary, 'account.json'),
    sessionsPath: path.join(temporary, 'sessions.json')
  });
  const session = authStore.createSession();
  const cookie = `grigdesk_sid=${session.id}`;
  let calls = 0;
  let fail = true;
  const help = createHelpService({
    root: '/',
    kind: 'packaged',
    read: async () => {
      calls += 1;

      if (fail) {
        throw new Error('PRIVATE-PATH-SENTINEL');
      }

      return corpus;
    }
  });
  const app = Fastify();

  t.after(async () => {
    await app.close();
    await rm(temporary, {
      recursive: true, force: true
    });
  });
  await app.register(authPlugin, {
    authStore
  });
  await app.register(helpModule, {
    help
  });
  app.get('/api/fixture-health', async () => ({
    ok: true
  }));
  assert.equal((await app.inject('/api/help')).statusCode, 401);
  assert.equal((await app.inject('/%61pi/help')).statusCode, 401);

  const denied = await app.inject({
    url: '/api/help', headers: {
      cookie
    }
  });

  assert.equal(denied.statusCode, 503);
  assert.equal(denied.body.includes('PRIVATE-PATH-SENTINEL'), false);
  assert.equal((await app.inject({
    url: '/api/fixture-health', headers: {
      cookie
    }
  })).statusCode, 200);
  fail = false;

  const [left, right] = await Promise.all([help.bundle(), help.bundle()]);

  assert.deepEqual(left, right);
  assert.equal(calls, 2);

  const response = await app.inject({
    url: '/api/help', headers: {
      cookie
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), corpus);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(await help.invoke({
    action: 'read', id: '../private'
  }), {
    ok: false, error: 'help_input_invalid'
  });
});
