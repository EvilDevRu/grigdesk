import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { api } from '../../web/src/shared/apiClient.ts';

process.env.NODE_ENV = 'test';

// Раскладка страницы «Чаты»: ширина списка и высота поля ввода — настройки устройства.
// Здесь стережём три вещи: разделитель реально меняет размер, выбор переживает
// перезагрузку (localStorage), а знак исполнителя в списке красится ЕГО цветом.
const CHATS_VIEW_PATH = fileURLToPath(new URL('../../web/src/views/ChatsView.vue', import.meta.url));
const CHAT_LIST_PATH = fileURLToPath(new URL('../../web/src/views/chat/ChatList.vue', import.meta.url));
const CHAT_SESSION_PATH = fileURLToPath(new URL('../../web/src/views/chat/ChatSession.vue', import.meta.url));
const CHAT_FIELDS_PATH = webFile('src/styles/components/fields.css');
const CHAT_ACTIONS_PATH = webFile('src/styles/components/actions.css');
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

const LIST_WIDTH_KEY = 'grigdesk-chats-list-width';

let nonce = 0;

const compileChatsView = () => compileVue(CHATS_VIEW_PATH, {
  stubs: {
    '../ui': `export {vTooltip} from './src/services/tooltipDirective.ts';`,
    '../stores/chat.ts': 'export const useChatStore = globalThis.__chatsResizeStore;',
    '../composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
      focus() {}, update() {}, blur() {},
    });`,
    '../shared/tools/viewport.ts': `export const useDockViewport = () => ({
      dockCapable: globalThis.__chatsDockCapable,
    });`,
    './chat/ChatList.vue': `
      import {h} from 'vue';
      export default {
        emits: ['open'],
        setup(_, {emit}) {
          return () => h('aside', {class: 'cl'}, h('button', {
            class: 'stub-open', onClick: () => emit('open'),
          }));
        },
      };`,
    './chat/ChatSession.vue': `export default {props: ['sid'], template: '<div class="cs"></div>'};`,
  },
});

const compileChatList = () => compileVue(CHAT_LIST_PATH, {
  stubs: {
    '../../stores/chat.ts': `
      export const useChatStore = globalThis.__chatListStore;
    `,
    '../../stores/providers.ts': `
      export const useProvidersStore = globalThis.__chatListProviders;
    `,
    '../../shared/ProviderIcon.vue': `
      export default {
        props: ['provider', 'size'],
        template: '<i class="pico"></i>',
      };
    `,
  },
});

let shared = null;
async function browserHarness() {
  if (shared) {
    shared.localStorage.clear();
    shared.document.body.innerHTML = '<div id="mount"></div>';
    return shared;
  }
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/chats' });
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
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  shared = browser;
  return browser;
}

// Раскладку happy-dom не считает (все rect нулевые), поэтому ширину контейнера задаём
// сами: проверяем арифметику разделителя, а не движок раскладки.
function stubHostWidth(el, width) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 800, width, height: 800, x: 0, y: 0 });
}

/**
 * Монтирует страницу с независимым стором и наблюдаемой поверхностью чата.
 * Запрос показа позволяет проверить открытие из ссылки на узком экране.
 */
async function mountChats(t, browser, { storedWidth, activeId = '', wide = true, revealRequest = '' } = {}) {
  const [{ mount }, { createPinia, defineStore }, { ref }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  if (storedWidth != null) browser.localStorage.setItem(LIST_WIDTH_KEY, String(storedWidth));
  const surface = {
    value: null,
    disposed: false,
    update(value) { this.value = { ...value }; },
    dispose() { this.disposed = true; },
  };
  const read = [];
  globalThis.__chatsDockCapable = ref(wide);
  globalThis.__chatsResizeStore = defineStore(`chats-resize-${nonce}`, {
    state: () => ({ activeId, revealRequest }),
    actions: {
      ensure() {},
      loadConveyor() {},
      consumeReveal() {
        this.revealRequest = '';
      },
      registerSurface(owner, initial) { surface.owner = owner; surface.value = { ...initial }; return surface; },
      markRead(id) { read.push(id); },
    },
  });
  const ChatsView = await compileChatsView();
  const wrapper = mount(ChatsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()] },
  });
  t.after(() => { if (wrapper.exists()) wrapper.unmount(); });
  stubHostWidth(wrapper.element, 1200);
  wrapper.__surface = surface;
  wrapper.__read = read;
  return wrapper;
}

const listVar = (wrapper) => wrapper.element.style.getPropertyValue('--chat-list-w').trim();

async function drag(wrapper, x) {
  const sp = wrapper.find('.lsplit');
  await sp.trigger('pointerdown', { pointerId: 1, button: 0, clientX: x });
  await sp.trigger('pointermove', { pointerId: 1, clientX: x });
  await sp.trigger('pointerup', { pointerId: 1, clientX: x });
}

test('список чатов: без выбора человека ширину решает CSS, а не встроенный стиль', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser);
  // Переменной нет вовсе — иначе медиазапрос ChatList (232px на планшете) был бы мёртв.
  assert.equal(listVar(wrapper), '');
  assert.equal(browser.localStorage.getItem(LIST_WIDTH_KEY), null);
});

test('COMP-VIS-05: mobile list не видит mounted ChatSession, открытый pane регистрирует exact surface', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser, { activeId: 'chat-mobile', wide: false });

  assert.deepEqual(wrapper.__surface.value, { chatId: 'chat-mobile', visible: false });
  assert.deepEqual(wrapper.__read, []);
  await wrapper.find('.stub-open').trigger('click');
  assert.deepEqual(wrapper.__surface.value, { chatId: 'chat-mobile', visible: true });
  assert.deepEqual(wrapper.__read, ['chat-mobile']);

  wrapper.unmount();
  assert.equal(wrapper.__surface.disposed, true);
});

test('список чатов: перетаскивание меняет ширину и сохраняет её', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser);

  await drag(wrapper, 420);
  assert.equal(listVar(wrapper), '420px');
  assert.equal(browser.localStorage.getItem(LIST_WIDTH_KEY), '420');
});

test('список чатов: ширина зажата минимумом и остатком места под сам чат', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser);

  await drag(wrapper, 40); // утащили за левый край
  assert.equal(listVar(wrapper), '220px');

  await drag(wrapper, 1180); // утащили за правый: чату должно остаться место
  assert.equal(listVar(wrapper), '560px');
});

test('список чатов: сохранённая ширина применяется при следующем открытии', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser, { storedWidth: 380 });
  assert.equal(listVar(wrapper), '380px');
});

test('список чатов: двойной клик возвращает умолчание и СТИРАЕТ настройку', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser, { storedWidth: 380 });

  await wrapper.find('.lsplit').trigger('dblclick');
  // Именно стирает, а не пишет 300: у планшета своё, более узкое умолчание.
  assert.equal(listVar(wrapper), '');
  assert.equal(browser.localStorage.getItem(LIST_WIDTH_KEY), null);
});

test('список чатов: разделитель управляется и с клавиатуры', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser, { storedWidth: 300 });
  const sp = wrapper.find('.lsplit');

  await sp.trigger('keydown', { key: 'ArrowRight' });
  assert.equal(listVar(wrapper), '316px');
  await sp.trigger('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(listVar(wrapper), '252px');
  await sp.trigger('keydown', { key: 'Home' });
  assert.equal(listVar(wrapper), '220px');
  assert.equal(browser.localStorage.getItem(LIST_WIDTH_KEY), '220');
  // Роль и границы — для скринридера и для теста один и тот же источник.
  assert.equal(sp.attributes('role'), 'separator');
  assert.equal(sp.attributes('aria-valuenow'), '220');
});

test('строка чата: знак исполнителя красится цветом исполнителя, безымянный остаётся нейтральным', async (t) => {
  const browser = await browserHarness();
  const [{ mount }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const rows = [
    { id: 'a', title: 'Про GrigDesk', snippet: '', ts: Date.now(), model: 'claude-opus-5' },
    { id: 'b', title: 'Про парсер', snippet: '', ts: Date.now(), model: 'gpt-5.6', sending: true },
    { id: 'c', title: 'Без модели', snippet: '', ts: Date.now(), model: 'ктотоещё' },
  ];

  globalThis.__chatListStore = defineStore(`chat-list-brand-${nonce}`, {
    state: () => ({
      loaded: true,
      loading: false,
      loadError: null,
      activeId: 'a',
      archived: [],
    }),
    actions: { list: () => rows, selectChat() {}, newSession() {}, renameChat() {}, deleteChat() {}, restoreArchived() {} },
  });
  globalThis.__chatListProviders = defineStore(`chat-list-prov-${nonce}`, {
    actions: {
      load() {},
      modelOf(ref) {
        if (ref === 'claude-opus-5') return { model: { name: 'Opus 5' }, provider: { id: 'claude', name: 'Claude', color: '#d97757' } };
        if (ref === 'gpt-5.6') return { model: { name: 'GPT-5.6' }, provider: { id: 'codex', name: 'Codex', color: '#10a37f' } };
        return { model: null, provider: null };
      },
    },
  });
  // R1: новый потребитель сна остаётся внутри тестовой сети. Источник не открывается,
  // поэтому общий useSse не заводит таймеров переподключения или проверки устойчивости.
  const previousSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');

  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    value: class {
      addEventListener() {}

      close() {}
    },
  });
  t.mock.method(api, 'get', async (url) => {
    assert.equal(url, '/api/chat/sessions');

    return { sessions: [] };
  });
  t.after(() => {
    if (previousSource) {
      Object.defineProperty(globalThis, 'EventSource', previousSource);
    } else {
      delete globalThis.EventSource;
    }
  });

  const ChatList = await compileChatList();
  const wrapper = mount(ChatList, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()] },
  });
  t.after(() => wrapper.unmount());

  const avas = wrapper.findAll('.ava');
  assert.equal(avas.length, 3);
  const primaryRows = wrapper.findAll('.row-hit');
  assert.equal(primaryRows.length, 3);
  assert.equal(primaryRows.every((entry) => entry.element.tagName === 'BUTTON'), true);
  assert.equal(primaryRows[0].attributes('aria-pressed'), 'true');
  assert.equal(wrapper.find('.row-hit button').exists(), false, 'action-кнопки не вложены в primary');
  assert.equal(avas[0].element.style.getPropertyValue('--prov').trim(), '#d97757');
  assert.equal(avas[0].classes().includes('brand'), true);
  assert.equal(avas[1].element.style.getPropertyValue('--prov').trim(), '#10a37f');
  // Работающий чат остаётся в цвете своего исполнителя: иначе все занятые чаты
  // сливаются между собой ровно тогда, когда их и различают.
  assert.equal(avas[1].classes().includes('live'), true);
  assert.equal(avas[1].classes().includes('brand'), true);
  // Исполнитель неизвестен (реестр не приехал) — красить нечем, знака тоже нет.
  assert.equal(avas[2].element.style.getPropertyValue('--prov').trim(), '');
  assert.equal(avas[2].classes().includes('brand'), false);
});

test('раскладка чата: JS и CSS считают одни и те же границы', async (t) => {
  const [list, session, fields, actions] = await Promise.all([
    readFile(CHAT_LIST_PATH, 'utf8'),
    readFile(CHAT_SESSION_PATH, 'utf8'),
    readFile(CHAT_FIELDS_PATH, 'utf8'),
    readFile(CHAT_ACTIONS_PATH, 'utf8'),
  ]);
  void t;

  // Ширину списка задаёт страница, но применяет её ChatList — через ту же переменную.
  assert.match(list, /\.cl \{ width: var\(--chat-list-w, 300px\)/);
  assert.match(list, /@media \(min-width: 900px\) and \(max-width: 1099px\) \{ \.cl \{ width: var\(--chat-list-w, 232px\); \} \}/);
  // Знак исполнителя красится и в покое, и во время работы.
  assert.match(list, /\.ava\.brand \{ color: color-mix\(in srgb, var\(--prov\)/);
  assert.match(list, /\.ava\.live \{ color: color-mix\(in srgb, var\(--prov, var\(--accent\)\)/);
  // Полную силу цвета держат ровно три состояния: открытый чат, вставший на вопросе и
  // работающий. Остальные приглушены ОБЕСЦВЕЧИВАНИЕМ (подмешан нейтральный `--ink-mid`),
  // а не прозрачностью и не затемнением: обе роняют контраст знака к своей заливке ниже
  // порога графики 3:1 — первым всегда тёмный фиолетовый Kimi.
  assert.match(
    list,
    /\.row:not\(\.cur\):not\(\.wait\) \.ava\.brand:not\(\.live\) \{\s*color: color-mix\(in srgb, var\(--prov\) 50%, var\(--ink-mid\)\);/,
  );
  assert.equal(/\.ava[^{]*\{[^}]*opacity:/.test(list), false);

  // Высота поля ввода: разделитель, переменная и ПОТОЛОК. Потолок дублируется в CSS
  // (поворот планшета скрипт не ловит), поэтому обе цифры обязаны совпадать — иначе
  // у разделителя появляется мёртвый ход: число меняется, поле стоит.
  assert.match(session, /class="cs-resize" role="separator" aria-orientation="horizontal"/);
  assert.match(fields, /data-role='chat-composer'\][^{]*\{[^}]*height: var\(--composer-h, auto\);/);
  assert.match(fields, /data-role='chat-composer'\][^{]*\{[^}]*max-height: 46vh;/);
  assert.match(session, /const COMPOSER_MAX_VH = 0\.46;/);
  // После удаления floating panel у полноразмерного composer остались один минимум и
  // один device-key; legacy key здесь даже не читается.
  assert.match(session, /const COMPOSER_MIN = 48;/);
  assert.match(fields, /data-role='chat-composer'\][^{]*\{[^}]*min-height: 48px;/);
  assert.match(
    fields,
    /data-role='chat-composer'\]:focus-visible\s*\{[^}]*box-shadow:\s*none;/,
  );
  assert.match(
    actions,
    /data-context='chat-context'\] \.ui-button__label\s*\{[^}]*overflow:\s*visible;/,
  );
  assert.match(list, /data-context="chat-list-new"/);
  assert.match(list, /data-context="chat-list-action"/);
  assert.match(
    actions,
    /data-context='chat-list-new'\]\s*\{[^}]*background:\s*var\(--surface-2\);/,
  );
  assert.match(
    actions,
    /data-context='chat-list-action'\]\s*\{[^}]*background:\s*var\(--ground\);/,
  );
  assert.match(session, /'grigdesk-chat-composer-h'/);
  assert.doesNotMatch(session, /grigdesk-chat-panel-composer-h/);
});

test('COMP-ALERT: ссылка раскрывает сам чат на узком экране', async (t) => {
  const browser = await browserHarness();
  const wrapper = await mountChats(t, browser, {
    activeId: 'chat-mobile',
    wide: false,
    revealRequest: 'chat-mobile',
  });

  await wrapper.vm.$nextTick();
  assert.deepEqual(wrapper.__surface.value, { chatId: 'chat-mobile', visible: true });
  assert.equal(globalThis.__chatsResizeStore().revealRequest, '');
});
