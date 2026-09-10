// Реалтайм у кокпита односторонний: сервер шлёт что угодно (`fastify.sse.broadcast`
// имён не фильтрует), а окно слушает ТОЛЬКО перечисленные в EVENT_NAMES — на каждое
// имя вешается свой addEventListener. Забыл имя — событие уходит в пустоту молча,
// без ошибки в консоли: страница просто «не обновляется сама».
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SSE_PATH = path.join(REPO_ROOT, 'web', 'src', 'composables', 'useSse.ts');
const TELEGRAM_VIEW_PATH = path.join(REPO_ROOT, 'web', 'src', 'views', 'TelegramView.vue');
const APP_SHELL_PATH = path.join(REPO_ROOT, 'web', 'src', 'shared', 'layout', 'AppShell.vue');

async function eventNames() {
  const src = await readFile(SSE_PATH, 'utf8');
  const block = src.match(/const EVENT_NAMES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'в useSse.js не найден список EVENT_NAMES');
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

test('общий inbox-changed и native telegram-status зарегистрированы без legacy telegram-inbox', async () => {
  const names = await eventNames();
  for (const name of ['inbox-changed', 'telegram-status']) {
    assert.ok(names.has(name), `${name} не слушается окном — реалтайм не придёт`);
  }
  assert.equal(names.has('telegram-inbox'), false);
});

test('единственный EventSource: своих в разделе «Телеграм» не заводим', async () => {
  // Лимит HTTP/1.1 — 6 соединений на хост, каждый лишний EventSource занимает одно
  // навсегда (см. docs/cockpit/gotchas.md). Подписка идёт через sseSubscribe.
  const src = await readFile(SSE_PATH, 'utf8');
  assert.equal((src.match(/new EventSource\(/g) || []).length, 1);
});

test('Telegram web-граница не содержит legacy queue routes/store/worker status', async () => {
  const [view, shell] = await Promise.all([
    readFile(TELEGRAM_VIEW_PATH, 'utf8'),
    readFile(APP_SHELL_PATH, 'utf8'),
  ]);
  assert.doesNotMatch(view, /\/api\/telegram\/inbox|telegram-inbox|res\.auto|status\.auto/u);
  assert.doesNotMatch(shell, /telegram-summary|useTelegramSummaryStore/u);
});
