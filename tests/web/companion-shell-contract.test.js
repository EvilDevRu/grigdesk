// Проверяет, что компаньон встроен в оболочку без возвращения удалённых ChatPanel и ChatTabs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';

const WEB_SRC = new URL('../../web/src/', import.meta.url);
const APP = new URL('../../web/src/App.vue', import.meta.url);
const CHAT_STORE = new URL('../../web/src/stores/chat.js', import.meta.url);
const CHAT_SESSION = new URL('../../web/src/views/chat/ChatSession.vue', import.meta.url);
const CHATS_VIEW = new URL('../../web/src/views/ChatsView.vue', import.meta.url);
const PIPELINE_VIEW = new URL('../../web/src/views/PipelineView.vue', import.meta.url);
const COMPANION_HOST = new URL('../../web/src/features/companion/CompanionHost.vue', import.meta.url);
const CHAT_PANEL = new URL('../../web/src/views/ChatPanel.vue', import.meta.url);
const CHAT_TABS = new URL('../../web/src/views/chat/ChatTabs.vue', import.meta.url);
const PANEL_KEY = 'cockpit-chat-panel-composer-h';
const PAGE_KEY = 'cockpit-chat-composer-h';

async function exists(url) {
  try { await access(url, constants.F_OK); return true; } catch { return false; }
}

async function sourceFiles(dir = WEB_SRC) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(entry.name, dir);
    if (entry.isDirectory()) files.push(...await sourceFiles(new URL(`${entry.name}/`, dir)));
    else if (/\.(?:js|vue)$/.test(entry.name)) files.push(url);
  }
  return files;
}

async function sources() {
  return Promise.all((await sourceFiles()).map(async (url) => ({
    url,
    text: await readFile(url, 'utf8'),
  })));
}

test('COMP-SHELL-01..03: App монтирует один CompanionHost только в authenticated-ветке и не знает ChatPanel', async () => {
  const app = await readFile(APP, 'utf8');
  assert.equal((app.match(/import\s+CompanionHost\b/g) || []).length, 1);
  assert.equal((app.match(/<CompanionHost\b/g) || []).length, 1);
  assert.match(app, /<LoginView\s+v-if="!auth\.authenticated"\s*\/>/);
  assert.match(app, /<SpeechProvider\s+v-else>[\s\S]*<CompanionHost\s*\/>[\s\S]*<\/SpeechProvider>/);
  assert.doesNotMatch(app, /ChatPanel/);
});

test('COMP-SHELL-04/06: legacy-файлы и panel branches удалены, ChatSession рендерится только в ChatsView', async () => {
  assert.equal(await exists(CHAT_PANEL), false);
  assert.equal(await exists(CHAT_TABS), false);
  const all = await sources();
  const joined = all.map(({ text }) => text).join('\n');
  assert.equal(/variant=["']panel["']/.test(joined), false, 'panel variant отсутствует в production tree');

  const renderSites = all.filter(({ url, text }) => (
    !url.pathname.endsWith('/ChatSession.vue') && /<ChatSession\b/.test(text)
  ));
  assert.deepEqual(renderSites.map(({ url }) => url.pathname), [CHATS_VIEW.pathname]);
});

test('COMP-SHELL-05/08: CompanionHost не встраивает полный чат и не создаёт второй SSE/poll owner', async () => {
  const host = await readFile(COMPANION_HOST, 'utf8');
  assert.equal(/ChatSession|ChatPermission|ChatQuestion|ChatTabs/.test(host), false,
    'companion не встраивает полный чат или decision forms');
  const companion = (await sources())
    .filter(({ url }) => url.pathname.includes('/features/companion/'))
    .map(({ text }) => text)
    .join('\n');
  assert.equal(/\bEventSource\b|\bsetInterval\s*\(|notifyWatch\.start\s*\(/.test(companion), false,
    'companion переиспользует существующих SSE/poll owners');
});

test('COMP-SHELL-07: chat store не владеет open/toggle/close/openFor оболочкой', async () => {
  const store = await readFile(CHAT_STORE, 'utf8');
  assert.equal(/\bopen\s*:\s*(?:true|false)/.test(store), false, 'legacy open state удалён');
  assert.equal(/\b(?:async\s+)?(?:open|toggle|close|openFor)\s*\(/.test(store), false,
    'legacy shell actions удалены');
});

test('COMP-SHELL-09: legacy panel key только best-effort удаляется, page composer key сохраняется', async () => {
  const all = await sources();
  const panelMentions = all.filter(({ text }) => text.includes(PANEL_KEY));
  assert.equal(panelMentions.length, 1);
  assert.match(panelMentions[0].text, new RegExp(`removeItem\\(['"]${PANEL_KEY}['"]\\)`));
  assert.doesNotMatch(panelMentions[0].text, new RegExp(`(?:getItem|setItem)\\(['"]${PANEL_KEY}`));
  const session = await readFile(CHAT_SESSION, 'utf8');
  assert.match(session, new RegExp(`['"]${PAGE_KEY}['"]`));
});

test('COMP-SHELL-10: device disable не размонтирует AppShell, /chats и pending owner', async () => {
  const app = await readFile(APP, 'utf8');
  assert.match(app, /<AppShell>/);
  assert.doesNotMatch(app, /v-if=["'][^"']*(?:companion|enabled)/i);
  const host = await readFile(COMPANION_HOST, 'utf8');
  assert.match(host, /enabled/);
});

test('cutover call-sites: Pipeline использует exact companion intent, полный чат page-only', async () => {
  const [pipeline, session, chats] = await Promise.all([
    readFile(PIPELINE_VIEW, 'utf8'),
    readFile(CHAT_SESSION, 'utf8'),
    readFile(CHATS_VIEW, 'utf8'),
  ]);
  assert.match(pipeline, /companion\.openForTask\(stage\.task\)/);
  assert.doesNotMatch(pipeline, /chat\.openFor\(/);
  assert.equal(/props\.variant|\bvariant\s*:|\.panel\s|chat\.close\(/.test(session), false,
    'ChatSession содержит только page layout');
  assert.match(session, /:disabled="frozen\s*\|\|\s*sess\.purpose\s*===\s*'companion'"/);
  assert.doesNotMatch(chats, /variant=["']page["']/);
});
