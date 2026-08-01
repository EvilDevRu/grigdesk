// Push-обновления обязаны покрывать ОБА поколения состояния. Маршруты v2 пишут реестр
// в отдельный каталог (движок требует непересечения с legacy), а fs.watch висел только
// на legacy: страница конвейера жила до ручного F5. На приёмочном прогоне t8165 это
// выглядело так: Скептик закончился, конвейер встал у ворот плана, чип в навигации
// (он опрашивает сам, раз в две минуты) зажёгся — а на схеме Скептик «горел» дальше.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import ssePlugin from '../../server/src/plugins/sse.js';

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

test('SSE watches both state generations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-sse-gen.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const stateV2Dir = path.join(root, 'state-v2');
  await mkdir(stateDir, { recursive: true });
  await mkdir(stateV2Dir, { recursive: true });

  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(ssePlugin, { stateDirs: [stateDir, stateV2Dir] });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  const res = await fetch(`${url}/api/events`);
  assert.equal(res.status, 200);
  const hello = await waitForEvent(res.body, 'hello', 2000);
  assert.equal(hello, true, 'поток открыт');

  const second = await fetch(`${url}/api/events`);
  // Изменение в каталоге v2 обязано разбудить окно так же, как в legacy.
  await writeFile(path.join(stateV2Dir, 't8165.pipeline'), 'GATE_PLAN=waiting\n');
  assert.equal(
    await waitForEvent(second.body, 'state-change', 5000),
    true,
    'запись в state-v2 рассылает state-change',
  );

  const third = await fetch(`${url}/api/events`);
  await writeFile(path.join(stateDir, 't7379.pipeline'), 'BUILD=running\n');
  assert.equal(
    await waitForEvent(third.body, 'state-change', 5000),
    true,
    'legacy-каталог по-прежнему рассылает state-change',
  );
});

test('a missing state directory does not break the remaining watchers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-sse-missing.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });

  const app = Fastify({ logger: false });
  t.after(() => app.close());
  // Второго поколения на диске ещё нет — это не повод остаться вообще без обновлений.
  await app.register(ssePlugin, { stateDirs: [stateDir, path.join(root, 'нет-такого')] });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  const res = await fetch(`${url}/api/events`);
  await writeFile(path.join(stateDir, 't7379.pipeline'), 'BUILD=running\n');
  assert.equal(await waitForEvent(res.body, 'state-change', 5000), true);
});
