// Отправка провайдерской слэш-команды через стор: признак slashCommand едет на сервер,
// автоназвание чата не инициируется (ни серверный хук, ни локальный provisional),
// пустой вывод команды приезжает плашкой role: 'note'.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE_PATH = fileURLToPath(new URL('../../web/src/stores/chat.js', import.meta.url));
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;
const CHAT_TITLE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/chat-title.js', import.meta.url),
)).href;
// Чистый модуль без Vue/pinia — подставляем настоящий по абсолютному URL: у `data:`-модуля
// нет базового пути, и относительный импорт уронил бы весь файл на этапе импорта.
const COMPANION_RUN_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/companion-run.js', import.meta.url),
)).href;

const apiHarness = {};
globalThis.__slashChatApi = apiHarness;

let patchedSource;
let instance = 0;

function patch(source) {
  return source
    .replace("import { defineStore } from 'pinia';", `import { defineStore } from "${PINIA_URL}";`)
    .replace("import { api } from '../shared/apiClient.ts';", 'const api = globalThis.__slashChatApi;')
    .replace(
      "import { router } from '../router.js';",
      "const router = { currentRoute: { value: { path: '/chats', meta: {} } } };"
      + ' const document = { hidden: false };',
    )
    .replace(
      "import { useUiContextStore } from './ui-context.js';",
      "const useUiContextStore = () => ({ capture: () => ({ promptContext: { page: '', path: '/chats' } }) });",
    )
    .replace(
      "import { useProvidersStore } from './providers.js';",
      'const useProvidersStore = () => ({ modelOf: (value) => {'
      + ' const id = typeof value === "object" ? value.model : (value || "test-model");'
      + ' const provider = typeof value === "object" && value.provider ? value.provider : "test-provider";'
      + ' return { id, model: { id }, provider: { id: provider } }; } });',
    )
    .replace(
      "import { notify } from '../shared/notify.ts';",
      'const notify = () => {};',
    )
    .replace(
      "import { sseSubscribe } from '../composables/useSse.ts';",
      'const sseSubscribe = () => () => {};',
    )
    .replace("import { mdToText } from '../shared/md.ts';", 'const mdToText = (x) => x;')
    .replace(
      "import { normalizeCompanionRun } from '../shared/companion-run.js';",
      `import { normalizeCompanionRun } from "${COMPANION_RUN_URL}";`,
    )
    .replace(
      "import { chatVisibility } from '../shared/chat-visibility.js';",
      'const chatVisibility = { isVisible: () => false, register: () => ({ update() {}, dispose() {} }) };',
    )
    // В отличие от helpers/chat-store.js хук названия оставляем НАСТОЯЩИМ: проверяем,
    // что слэш-команда его не инициирует.
    .replace(
      /import \{[^}]*\} from '\.\.\/shared\/chat-title\.js';/,
      `import { applyGeneratedChatTitle, firstMessageTitle, provisionalChatTitle, shouldRequestChatTitle } from "${CHAT_TITLE_URL}";`,
    );
}

async function fixture(sessions) {
  if (!patchedSource) patchedSource = patch(await readFile(STORE_PATH, 'utf8'));
  const [{ createPinia, setActivePinia }, { useChatStore }] = await Promise.all([
    import(PINIA_URL),
    import(`data:text/javascript;base64,${Buffer.from(
      `${patchedSource}\n// экземпляр ${++instance}`,
    ).toString('base64')}`),
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
  apiHarness.post = async (url, body) => { bodies.push({ url, body }); return { reply: 'Session status: ok', sessionId: 'k1' }; };

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
    return new Promise((resolve) => { resolveGet = resolve; });
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
  chat._load = async () => { chat.loaded = true; };
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
  apiHarness.post = async () => ({ reply: '✓ Команда /status выполнена локально — вывода нет.', note: true, sessionId: 'k1' });

  await chat.send('s2', '/status', [], { slashCommand: '/status' });

  const last = chat.sessions[0].messages.at(-1);
  assert.equal(last.role, 'note');
  assert.match(last.text, /выполнена локально/);
});

test('обычное первое сообщение по-прежнему просит название (контраст)', async () => {
  const chat = await fixture([freshSession('s3')]);
  const bodies = [];
  apiHarness.post = async (url, body) => { bodies.push(body); return { reply: 'ответ', sessionId: 'k1' }; };

  await chat.send('s3', 'Расскажи про слэш-команды');

  assert.equal(bodies[0].requestTitle, true);
  assert.equal(bodies[0].slashCommand, undefined);
  assert.notEqual(chat.sessions[0].title, '', 'provisional-заголовок на месте');
});
