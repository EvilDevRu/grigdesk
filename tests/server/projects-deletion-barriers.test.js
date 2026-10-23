import assert from 'node:assert/strict';
import test from 'node:test';

import { pdFixture, pdProjectsApp, pdSnapshot } from './helpers/projects-deletion.js';

test('PD-B1: архив сохраняет файлы и данные владельцев', async (t) => {
  const f = await pdFixture(t, { git: true });
  const before = await pdSnapshot(f);
  const other = f.prefs.readStored().projects.other;

  await f.service.archive('demo', 1);

  assert.deepEqual(await pdSnapshot(f), before);
  assert.deepEqual(f.prefs.readStored().projects.other, other);
});

test('PD-B2: настоящий auth защищает чтение и архив', async (t) => {
  const f = await pdFixture(t);
  const app = await pdProjectsApp(t, f, { auth: true });

  for (const options of [
    { method: 'GET', url: '/api/projects' },
    {
      method: 'POST',
      url: '/api/projects/demo/archive',
      payload: {
        expectedRevision: 1
      }
    },
  ]) {
    const anonymous = await app.inject(options);

    assert.equal(anonymous.statusCode, 401, anonymous.body);
    assert.match(anonymous.headers['cache-control'], /no-store/);
    assert.equal(f.prefs.readStored().projects.demo.revision, 1);

    const authorized = await app.inject({ ...options, headers: { 'x-grigdesk-token': 'pd-cli-token' } });

    assert.equal(authorized.statusCode, 200, authorized.body);
  }
});
