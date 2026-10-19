import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

import { within } from './common.mts';
import { preferences, server } from './harness.mts';

const root = process.argv[2]!;
let waiting: ServerResponse | undefined;
let heldId = '';
let killedId = '';
let observedHold!: () => void;
const held = new Promise<void>((resolve) => {
  observedHold = resolve;
});
const database = createServer((request, response) => {
  let query = '';

  request.setEncoding('utf8');
  request.on('data', (chunk: string) => {
    query += chunk;
  });
  request.on('end', () => {
    const url = new URL(request.url!, 'http://localhost');

    response.setHeader('Content-Type', 'application/json');

    if (query.startsWith('KILL QUERY')) {
      killedId = url.searchParams.get('param_query_id') ?? '';
      response.end();

      return;
    }

    if (query.includes('sea_hold')) {
      waiting = response;
      heldId = url.searchParams.get('query_id') ?? '';
      observedHold();

      return;
    }

    response.end('{"answer":42}\n');
  });
});

database.listen(0, '127.0.0.1');
await once(database, 'listening');
await preferences({ 'sea-fixture': true });
await mkdir('/D/plugins/sea-fixture', { recursive: true });
await writeFile('/D/plugins/sea-fixture/package.json', '{"type":"module"}');
await writeFile('/D/plugins/sea-fixture/plugin.json', JSON.stringify({
  id: 'sea-fixture',
  name: 'SEA Fixture',
  version: '1.0.0',
  api: 1,
}));
await writeFile('/D/plugins/sea-fixture/relative.js', 'export const answer = 42;\n');
await writeFile('/D/plugins/sea-fixture/server.js', `
import { writeFile } from 'node:fs/promises';
import { answer } from './relative.js';
export default async function (app, { dataDir, lifecycle }) {
  lifecycle.busyReason = () => 'fixture busy';
  app.get('/answer', async () => ({ answer, busy: await lifecycle.busyReason() }));
  app.addHook('onClose', async () => writeFile(dataDir + '/closed', 'closed'));
}
`);

const run = await server(root);
let result: Record<string, unknown> = {};

try {
  const engines = (await run.request('/api/db/engines')).engines
    .map((item: { id: string }) => item.id).sort();
  const providers = (await run.request('/api/providers')).providers;

  assert.equal(providers.find((item: { id: string }) => item.id === 'deepseek').available, false);
  assert.deepEqual(await run.request('/api/ext/sea-fixture/answer'), { answer: 42, busy: 'fixture busy' });

  const profile = await run.request('/api/db/profiles', 'POST', {
    projectId: 'fixture',
    label: 'local',
    role: 'read',
    engine: 'clickhouse',
    host: '127.0.0.1',
    port: (database.address() as { port: number }).port,
    user: 'fixture',
    database: 'default',
  });
  const session = (await run.request(`/api/db/profiles/${profile.id}/sessions`, 'POST')).session;
  const query = await run.request(`/api/db/sessions/${session.id}/query`, 'POST', { text: 'SELECT 42' }, 202);
  let completed;
  const deadline = Date.now() + 10000;

  do {
    completed = await run.request(`/api/db/queries/${query.queryId}`);

    if (completed.state === 'done') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  assert.equal(completed.state, 'done', JSON.stringify(completed));
  assert.deepEqual(completed.result.rows, [{ answer: 42 }]);

  const slow = await run.request(`/api/db/sessions/${session.id}/query`, 'POST',
    { text: 'SELECT sea_hold' }, 202);

  await within(held, 10000);
  assert.deepEqual(await run.request(`/api/db/queries/${slow.queryId}/cancel`, 'POST'),
    { ok: true, method: 'query' });
  assert.equal(killedId, slow.queryId);
  assert.equal(heldId, slow.queryId);
  waiting!.end('{"cancelled":true}\n');
  await run.request(`/api/db/sessions/${session.id}`, 'DELETE');
  result = {
    engines,
    providers: providers.map((item: { id: string }) => item.id).sort(),
    query: true,
    cancel: true,
    plugin: true,
  };
} finally {
  waiting?.end();
  assert.equal((await run.stop()).code, 0, run.log());
  database.closeAllConnections();
  await new Promise<void>((resolve) => database.close(() => resolve()));
}

assert.equal(await readFile('/D/plugin-data/sea-fixture/closed', 'utf8'), 'closed');
console.log(JSON.stringify({ ...result, lifecycle: true }));
