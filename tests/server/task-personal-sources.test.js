import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { multiFixture, shelfInput } from './helpers/trackerMulti.js';

const id = '100000000001';
const routes = [
  ['GET', 'favorites'],
  ['PUT', `favorites/${id}`],
  ['DELETE', `favorites/${id}`],
  ['GET', 'seen'],
  ['POST', 'seen', { taskIds: [id] }],
  ['GET', 'shelf'],
  ['PUT', `shelf/${id}`, shelfInput()],
  ['DELETE', `shelf/${id}`],
];

for (const [method, suffix, payload] of routes) {
  test(`OWN-REMOVED-PERSONAL-HTTP: ${method} ${suffix} больше не обслуживается`, async (t) => {
    const fixture = await multiFixture(t, { personal: true });

    await writeFile(path.join(fixture.root, 'tasks.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextId: '100000000010',
      tasks: [{
        id,
        source: 'grigdesk',
        title: 'Архив',
        description: 'История',
        projectId: 'beta',
        projectTitle: 'Проект beta',
        sourceUrl: `http://client.test/#/board?openTask=${id}`,
        createdAt: '2026-10-24T00:00:00.000Z',
      }],
    }));

    const before = await fixture.request('GET', '/api/tracker/task-favorites');
    const response = await fixture.request(method, `/api/grigdesk-tasks/task-${suffix}`, payload);

    assert.equal(before.statusCode, 200, before.body);
    assert.equal(response.statusCode, 404, response.body);
    assert.deepEqual((await fixture.request('GET', '/api/tracker/task-favorites')).json(), before.json());
  });
}

test('OWN-REMOVED-PERSONAL-HTTP: query/body source не выбирают scope внешних меток', async (t) => {
  const fixture = await multiFixture(t, { personal: true });

  for (const prefix of ['/api/tracker', '/api/tracker/fixture-b']) {
    const response = await fixture.request('GET', `${prefix}/task-favorites?source=grigdesk&scope=grigdesk`);

    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.json().scope, /^[a-f0-9]{64}$/u);

    const added = await fixture.request('PUT', `${prefix}/task-favorites/42`, {
      source: 'grigdesk',
      scope: 'grigdesk',
    });

    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().scope, response.json().scope);
    assert.deepEqual(added.json().taskIds, ['42']);
  }
});
