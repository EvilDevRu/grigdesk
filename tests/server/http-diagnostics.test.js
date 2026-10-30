import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { installHttpDiagnostics } from '../../server/src/lib/httpDiagnostics.ts';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireServer('fastify');

test('Server-Timing измеряет сервер и следует общему уровню логирования', async (t) => {
  let clock = 0;
  const app = Fastify({ logger: { level: 'debug' } });

  t.mock.method(performance, 'now', () => clock);
  t.after(() => app.close());
  installHttpDiagnostics(app);
  app.get('/api/probe', async (_request, reply) => {
    clock += 42;
    reply.header('server-timing', 'db;dur=2');

    return { ok: true };
  });

  const first = await app.inject('/api/probe?private=secret');

  assert.equal(first.headers['server-timing'], 'db;dur=2, grigdesk;dur=42.0');
  assert.deepEqual(first.json(), { ok: true });
  app.log.level = 'info';

  const disabled = await app.inject('/api/probe');

  assert.equal(disabled.headers['server-timing'], 'db;dur=2');
  app.log.level = 'debug';

  const resumed = await app.inject('/api/probe');

  assert.equal(resumed.headers['server-timing'], 'db;dur=2, grigdesk;dur=42.0');
});
