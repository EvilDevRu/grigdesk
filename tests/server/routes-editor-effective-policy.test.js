import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import routesModule from '../../server/src/modules/routes/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('RE-F4-07: профильная политика этапа читается без записи в route bundle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-route-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  await fs.mkdir(path.join(profilesDir, 'sample'), { recursive: true });
  await fs.writeFile(path.join(profilesDir, 'sample', 'runners.env'), [
    'PROJECT_RUNNER_PRIMARY=codex',
    'STAGE_BUILD_PRIMARY=claude',
    'MODEL_BUILD_CLAUDE_EXACT=synthetic-model',
    'MODEL_BUILD_CLAUDE_EFFORT=high',
    'API_KEY=synthetic-secret',
    '',
  ].join('\n'));
  const app = Fastify({ logger: false });
  await app.register(routesModule, { config: {
    routesDir: path.join(root, 'routes'),
    routesAuthoringDir: path.join(root, 'routes.authoring'),
    profilesDir,
  }, prefs: { read: () => ({ projects: { sample: {} } }), write: () => {} } });
  await app.ready();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET',
    url: '/api/routes/sample/editor/policy/BUILD' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().runKey, 'BUILD');
  assert.equal(response.json().primary, 'claude');
  assert.equal(response.json().models.claude.exact, 'synthetic-model');
  assert.equal(response.json().models.claude.effort, 'high');
  assert.equal(response.body.includes('synthetic-secret'), false);
});
