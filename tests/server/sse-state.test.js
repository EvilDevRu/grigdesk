// Push-обновления читаются из единственного runtime-каталога движка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import ssePlugin from '../../server/src/plugins/sse.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/** Читает поток SSE, пока не встретит нужное событие. */
async function waitForEvent(body, name, timeoutMs) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => { setTimeout(() => resolve({ timeout: true }), deadline - Date.now()); }),
      ]);
      if (chunk.timeout || chunk.done) return false;
      buf += decoder.decode(chunk.value, { stream: true });
      if (buf.includes(`event: ${name}`)) return true;
    }
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

test('SSE watches the single factory state directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sse-gen.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });

  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(ssePlugin, { stateDir });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  const res = await fetch(`${url}/api/events`);
  assert.equal(res.status, 200);
  const hello = await waitForEvent(res.body, 'hello', 2000);
  assert.equal(hello, true, 'поток открыт');

  const second = await fetch(`${url}/api/events`);
  await writeFile(path.join(stateDir, 't41.pipeline'), 'BUILD=running\n');
  assert.equal(
    await waitForEvent(second.body, 'state-change', 5000),
    true,
    'запись в state рассылает state-change',
  );
});
