import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { trackerFixture } from './helpers/trackerFixture.js';

const operations = [
  ['GET', '/api/grigdesk-tasks'],
  ['GET', '/api/grigdesk-tasks/projects'],
  ['GET', '/api/grigdesk-tasks/100000000001'],
  ['POST', '/api/grigdesk-tasks'],
];

for (const [method, url] of operations) {
  test(`OWN-REMOVED-HTTP: ${method} ${url} закрыт без изменения архива`, async (t) => {
    const fixture = await trackerFixture(t);
    const archive = path.join(fixture.root, 'tasks.json');
    const bytes = JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextId: '100000000010',
      tasks: [{
        id: '100000000001',
        source: 'grigdesk',
        title: 'Архив',
        description: 'Сохранённый текст',
        projectId: 'beta',
        projectTitle: 'Проект beta',
        sourceUrl: 'http://client.test/#/board?openTask=100000000001',
        createdAt: '2026-10-24T00:00:00.000Z',
      }],
    });

    await writeFile(archive, bytes);

    const response = await fixture.request(method, url, method === 'POST' ? {
      title: 'Не создавать',
      description: 'Архив не меняется',
      projectId: 'beta',
      clientOrigin: 'http://client.test',
    } : undefined);

    assert.equal(await readFile(archive, 'utf8'), bytes);
    assert.equal(response.statusCode, 404, response.body);
    assert.deepEqual(fixture.events, []);
  });
}

test('OWN-REMOVED-HTTP: старые чтения и создание недоступны без авторизации', async (t) => {
  const fixture = await trackerFixture(t);

  for (const [method, url] of operations) {
    const response = await fixture.app.inject({ method, url });

    assert.ok([401, 404].includes(response.statusCode), response.body);
  }

  for (const [method, url] of [['GET', '/api/tracker/dashboard'], ['POST', '/api/tracker/tasks']]) {
    const response = await fixture.app.inject({ method, url });

    assert.equal(response.statusCode, 401, response.body);
  }
});
