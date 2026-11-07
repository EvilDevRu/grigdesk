// Кнопка «Продолжить ход». Смысл проверки: раньше она рисовалась только у хода,
// прерванного перезапуском сервера, а после обрыва самим CLI (сеть, недельный лимит)
// человеку предлагали набрать «Продолжай» руками. Обе метки прерывания ведут к одной
// кнопке, но текст продолжения называет свою причину; без метки кнопки нет.
import assert from 'node:assert/strict';

globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;
import test from 'node:test';
import { compileChatSession as compileChatSessionHarness } from './helpers/chat-session.js';

process.env.NODE_ENV = 'test';

const compileChatSession = () => compileChatSessionHarness('__resumeCut');

const PROVIDERS = [{
  id: 'claude',
  name: 'Claude',
  color: '#d97757',
  available: true,
  models: [{ id: 'claude-opus-5', name: 'Opus 5', efforts: [] }],
}];

async function installBrowser(t) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'https://grigdesk.test/#/chats' });

  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());

  return browser;
}

function modelOf(value) {
  const id = value && typeof value === 'object' ? value.model || '' : value || '';
  const provider = PROVIDERS.find((item) => item.models.some((model) => model.id === id)) || null;

  return { id, model: provider?.models.find((model) => model.id === id) || null, provider };
}

async function mountChat(t, messages) {
  const browser = await installBrowser(t);
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const session = reactive({
    id: 'resume-chat',
    taskId: null,
    title: 'Оборванный ход',
    model: 'claude-opus-5',
    modelRef: { provider: 'claude', model: 'claude-opus-5' },
    effort: '',
    mode: '',
    messages: structuredClone(messages),
    steps: [],
    draft: '',
    sessionId: 'sess-1',
    contextTokens: 0,
    sending: false,
    compacting: false,
    sessionResetting: false,
  });
  const sent = [];

  globalThis.__resumeCutApi = {
    url: (path) => path,
    async get(path) { return path === '/api/tasks' ? { tasks: [] } : {}; },
    async post() { return {}; },
  };
  globalThis.__resumeCutChatStore = () => ({
    sessions: [session],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    setEffort() {},
    setMode() {},
    setTask() {},
    setTitle() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
    async send(sid, text, atts) { sent.push({ sid, text, atts }); return true; },
  });
  globalThis.__resumeCutTasksStore = () => ({ async load() { return null; } });
  globalThis.__resumeCutUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__resumeCutRouter = { async push() {} };
  globalThis.__resumeCutProvidersStore = () => ({
    providers: PROVIDERS,
    load() {},
    modelOf,
    visibleModels(provider) { return provider.models; },
    modesOf() { return []; },
  });

  const [{ mount, flushPromises }, ChatSession] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession(),
  ]);
  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__resumeCutApi;
    delete globalThis.__resumeCutChatStore;
    delete globalThis.__resumeCutTasksStore;
    delete globalThis.__resumeCutUiStore;
    delete globalThis.__resumeCutRouter;
    delete globalThis.__resumeCutProvidersStore;
  });
  await flushPromises();

  return { wrapper, session, sent, flushPromises };
}

const resumeButton = (wrapper) => wrapper.find('[data-role="chat-resume-interrupted"]');

test('обрыв CLI: у плашки ошибки есть «Продолжить ход», текст называет обрыв, не перезапуск', async (t) => {
  const { wrapper, sent, flushPromises } = await mountChat(t, [
    { role: 'user', text: 'сделай' },
    {
      role: 'error',
      text: '⚠ Ход оборвал сам CLI, ответа модели не было: «You\'ve hit your weekly limit».',
      interruptedBy: 'delivery_failure',
      steps: [{ k: 'text', text: 'работал', at: 1 }],
    },
  ]);

  const button = resumeButton(wrapper);
  assert.ok(button.exists(), 'у оборванного CLI хода нет кнопки продолжения');
  assert.ok(wrapper.find('.msg.error .m-resume').exists(), 'кнопка стоит в плашке самой ошибки');
  assert.equal(button.attributes('data-size'), 'compact', 'кнопка продолжения не растягивает ленту');

  await button.trigger('click');
  await flushPromises();

  assert.equal(sent.length, 1, 'продолжение — одно обычное сообщение в тот же чат');
  assert.equal(sent[0].sid, 'resume-chat');
  assert.match(sent[0].text, /оборвал сам CLI/, 'агенту называют настоящую причину');
  assert.doesNotMatch(sent[0].text, /перезапустился/, 'про перезапуск сервера речи нет');
  assert.match(sent[0].text, /сверь, что уже сделано/);
});

test('перезапуск сервера: текст продолжения по-прежнему про перезапуск', async (t) => {
  const { wrapper, sent, flushPromises } = await mountChat(t, [
    { role: 'user', text: 'сделай' },
    {
      role: 'assistant',
      text: '⏹ Ход прерван перезапуском сервера — память сессии сохранена.',
      stopped: true,
      interruptedBy: 'server_shutdown',
      model: 'claude-opus-5',
    },
  ]);

  await resumeButton(wrapper).trigger('click');
  await flushPromises();

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /перезапустился/);
  assert.doesNotMatch(sent[0].text, /оборвал сам CLI/);
});

test('ошибка без метки прерывания кнопку не получает', async (t) => {
  const { wrapper } = await mountChat(t, [
    { role: 'user', text: 'сделай' },
    { role: 'error', text: 'Сжать контекст не удалось: таймаут' },
  ]);

  assert.ok(!resumeButton(wrapper).exists(), 'ошибке без сохранённой сессии продолжать нечего');
});

test('метка не у последнего сообщения кнопку не показывает', async (t) => {
  const { wrapper } = await mountChat(t, [
    { role: 'user', text: 'сделай' },
    { role: 'error', text: '⚠ Ход оборвал сам CLI.', interruptedBy: 'delivery_failure' },
    { role: 'user', text: 'Продолжай' },
    { role: 'assistant', text: 'Готово.', model: 'claude-opus-5' },
  ]);

  assert.ok(!resumeButton(wrapper).exists(), 'ход уже продолжили — старая кнопка не нужна');
});
