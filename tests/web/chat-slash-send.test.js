import { loadProductModule } from './helpers/compile-vue.js';
import { migrationUrl } from './helpers/compile-vue.js';
// Отправка провайдерской слэш-команды через стор: признак slashCommand едет на сервер,
// автоназвание чата не инициируется (ни серверный хук, ни локальный provisional),
// пустой вывод команды приезжает плашкой role: 'note'.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE_PATH = fileURLToPath(migrationUrl('src/stores/chat.ts'));
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;
const CHAT_TITLE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/chatTitle.ts', import.meta.url),
)).href;
const CONTEXT_USAGE_URL = new URL('../../shared/chat/chatContextUsage.ts', import.meta.url).href;
const CHAT_RUN_URL = new URL('../../shared/chat/chatRun.ts', import.meta.url).href;
const IN_TURN_CONTRACT_URL = new URL('../../shared/chat/chatInTurnContracts.ts', import.meta.url).href;
const IN_TURN_STORE_URL = new URL('../../web/src/stores/chatInTurn.ts', import.meta.url).href;

const apiHarness = {};

globalThis.__slashChatApi = apiHarness;

/**
 * Хук заголовка остаётся настоящим, чтобы slash-команда проверяла его отсутствие.
 * Меняются только порты окна; исходный TS больше не попадает в data:javascript.
 */
function slashStubs() {
  return {
    '../shared/apiClient.ts': 'export const api = globalThis.__slashChatApi;',
    '../shared/alerts.ts': `export const alertUser = () => true;
      export const dismissAlert = () => {}; export const dismissAlertScope = () => {};`,
    '../router.ts': `export const router = {currentRoute: {value: {path: '/chats', meta: {}}}};`,
    './uiContext.ts': `export const useUiContextStore = () => ({capture: () => ({
      promptContext: {page: '', path: '/chats'},
    })});`,
    './providers.ts': `export const useProvidersStore = () => ({modelOf(value) {
      const id = typeof value === 'object' ? value.model : (value || 'test-model');
      const provider = typeof value === 'object' && value.provider ? value.provider : 'test-provider';
      return {id, model: {id}, provider: {id: provider}};
    }});`,
    '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
    '../shared/md.ts': 'export const mdToText = (value) => value;',
    '../shared/chatVisibility.ts': `export const chatVisibility = {
      isVisible: () => false, register: () => ({update() {}, dispose() {}}),
    };`,
  };
}

/**
 * Каждый тест получает отдельный модуль и собственный Pinia store.
 * Sent-база фиксируется после назначения чатов, поэтому dirty-проверка остаётся настоящей.
 */
async function fixture(sessions) {
  const [{ createPinia, setActivePinia }, { useChatStore }] = await Promise.all([
    import(PINIA_URL),
    loadProductModule('src/stores/chat.ts', slashStubs()),
  ]);

  setActivePinia(createPinia());

  const chat = useChatStore();

  chat.sessions = sessions;
  chat.activeId = sessions[0]?.id || null;
  chat.loaded = true;
  apiHarness.get = async () => ({ active: [] });
  apiHarness.post = async () => ({});
  apiHarness.put = async () => ({});
  apiHarness.del = async () => ({});
  chat._markSent();

  return chat;
}

const freshSession = (id) => ({
  id,
  taskId: null,
  title: '',
  model: 'kimi-code/k3',
  modelRef: { provider: 'kimi', model: 'kimi-code/k3' },
  messages: [],
  sessionId: null,
  draft: '',
  sending: false,
  compacting: false,
  steps: [],
  createdAt: 100,
  updatedAt: 200,
});

test('send со slashCommand шлёт признак на сервер и не инициирует автоназвание', async () => {
  const chat = await fixture([freshSession('s1')]);
  const bodies = [];

  apiHarness.post = async (url, body) => {
                       bodies.push({ url, body });

                      return { reply: 'Session status: ok', sessionId: 'k1' };
                    };

  const accepted = await chat.send('s1', '/status', [], { slashCommand: '/status' });

  assert.equal(accepted, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].url, '/api/chat');
  assert.equal(bodies[0].body.slashCommand, '/status');
  assert.equal(bodies[0].body.requestTitle, false, 'серверный титул-хук не запрашивается');

  const s = chat.sessions[0];

  assert.equal(s.title, '', 'provisional-заголовок от текста команды не ставится');

  const last = s.messages.at(-1);

  assert.equal(last.role, 'assistant');
  assert.equal(last.text, 'Session status: ok');
});

test('поздний speech GET не откатывает снимок, уже обновлённый через SSE', async () => {
  const chat = await fixture([freshSession('speech-race')]);

  chat.setSpeechSnapshot({
    settings: { engine: 'browser', revision: 'rev-before' },
  });

  let resolveGet;

  apiHarness.get = (url) => {
    assert.equal(url, '/api/settings/speech');

    return new Promise((resolve) => {
                          resolveGet = resolve;
                       });
  };

  const pending = chat._resyncSpeech();

  chat.setSpeechSnapshot({
    settings: { engine: 'whisper', revision: 'rev-after' },
  });
  resolveGet({ settings: { engine: 'browser', revision: 'rev-before' } });
  await pending;

  assert.equal(chat.speech.engine, 'whisper');
  assert.equal(chat.speech.revision, 'rev-after');
});

test('initial ensure сверяет speech без зависимости от уже прошедшего hello', async () => {
  const chat = await fixture([freshSession('initial-speech')]);
  let resyncs = 0;

  chat._load = async () => {
                  chat.loaded = true;
               };
  chat.initPerms = () => {};
  chat._resyncSpeech = () => {
    resyncs += 1;

    return Promise.resolve();
  };

  await chat.ensure();

  assert.equal(resyncs, 1);
});

test('пустой вывод слэш-команды складывается плашкой role: note', async () => {
  const chat = await fixture([freshSession('s2')]);

  apiHarness.post = async () => ({
    reply: '✓ Команда /status выполнена локально — вывода нет.',
    note: true,
    sessionId: 'k1'
  });

  await chat.send('s2', '/status', [], { slashCommand: '/status' });

  const last = chat.sessions[0].messages.at(-1);

  assert.equal(last.role, 'note');
  assert.match(last.text, /выполнена локально/);
});

test('обычное первое сообщение по-прежнему просит название (контраст)', async () => {
  const chat = await fixture([freshSession('s3')]);
  const bodies = [];

  apiHarness.post = async (url, body) => {
                       bodies.push(body);

                      return { reply: 'ответ', sessionId: 'k1' };
                    };

  await chat.send('s3', 'Расскажи про слэш-команды');

  assert.equal(bodies[0].requestTitle, true);
  assert.equal(bodies[0].slashCommand, undefined);
  assert.notEqual(chat.sessions[0].title, '', 'provisional-заголовок на месте');
});
