// Событие, которое фронт обрабатывает, обязано быть в EVENT_NAMES.
//
// EventSource доставляет ИМЕНОВАННЫЕ события только тем, кто на них подписался. Поэтому
// `broadcast('chat-turn-start')` на сервере и `if (name === 'chat-turn-start')` в сторе
// сами по себе ничего не значат: без имени в списке подписчика ветка не выполняется
// никогда. Отказ молчаливый — выглядит как «иногда не обновляется», и живой случай
// (метка «ждёт очереди» и индикация сжатия на втором устройстве) прожил незамеченным.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SRC = fileURLToPath(new URL('../../web/src/', import.meta.url));
const SERVER_SRC = fileURLToPath(new URL('../../server/src/', import.meta.url));

async function walk(dir, ext) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full, ext));
    else if (ext.some((suffix) => entry.name.endsWith(suffix))) found.push(full);
  }
  return found;
}

async function subscribedNames() {
  const source = await readFile(path.join(WEB_SRC, 'composables/useSse.ts'), 'utf8');
  const list = source.match(/const EVENT_NAMES = \[([\s\S]*?)\];/);
  assert.ok(list, 'список подписки не найден — его нельзя переносить без обновления сторожа');
  return new Set([...list[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
}

test('SSE: фронт подписан на все события, которые сам обрабатывает', async () => {
  const names = await subscribedNames();
  const handled = new Set();

  for (const file of await walk(WEB_SRC, ['.js', '.ts', '.vue'])) {
    if (file.endsWith(path.join('composables', 'useSse.ts'))) continue;
    const source = await readFile(file, 'utf8');
    // Ветки вида `name === 'chat-step'` — единственная форма реакции на SSE в кокпите.
    for (const match of source.matchAll(/name === '([a-z-]+)'/g)) handled.add(match[1]);
  }

  // Отсеиваем совпадения из других сравнений по имени: интересуют только те, что
  // действительно рассылает сервер.
  const broadcast = new Set();
  for (const file of await walk(SERVER_SRC, ['.js'])) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/broadcast\('([a-z-]+)'/g)) broadcast.add(match[1]);
  }

  const missing = [...handled].filter((name) => broadcast.has(name) && !names.has(name));
  assert.deepEqual(
    missing,
    [],
    `эти события сервер шлёт и фронт их ждёт, но подписки нет: ${missing.join(', ')}`,
  );
});

test('SSE: SSH-инвалидации входят в единственную подписку вкладки', async () => {
  const names = await subscribedNames();

  assert.deepEqual(
    ['ssh-sessions', 'ssh-permission', 'ssh-audit'].filter((name) => !names.has(name)),
    [],
  );
});
