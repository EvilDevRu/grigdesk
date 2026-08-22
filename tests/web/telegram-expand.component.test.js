// Блок «Обсуждение в Telegram» в модалке задачи.
//
// Главное требование раздела 5 плана: НЕРАСКРЫТАЯ ссылка показывается с причиной,
// а не исчезает молча — иначе пустая модалка читается как «в чате ничего нет».
// Второе требование: у отказа наружу не уходит содержимое (ни текста, ни имени
// чужого чата) — модалка не имеет права додумывать за сервером.
//
// Про замер раскладки. План просит проверить, что длинная цитата не выталкивает
// колонку (scrollWidth против clientWidth). В офлайн-наборе настоящего браузера
// нет, а happy-dom раскладку не считает вовсе — замерять там нечего. Поэтому
// правила переноса проверяются статически, по объявленному <style scoped>;
// живой замер остаётся ручным шагом в headless Chrome.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/TaskModal.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const PINIA_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/pinia/dist/pinia.mjs', import.meta.url),
)).href;

let compileNonce = 0;

async function compileTaskModal() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: `data-v-tg-expand-${++compileNonce}`,
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replaceAll("from 'pinia'", `from "${PINIA_URL}"`)
    .replace(
      "import { useRouter } from 'vue-router';",
      'const useRouter = () => ({ push() {} });',
    )
    .replace(
      "import { useUiContextSource } from '../composables/useUiContextSource.js';",
      'const useUiContextSource = () => ({ focus() {}, update() {}, blur() {} });',
    )
    .replace(
      "import { api } from '../shared/api-client.js';",
      'const api = globalThis.__tgExpandApi;',
    )
    .replace(
      "import { confirmDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = async () => true;',
    )
    .replace(
      "import { registerLayer } from '../shared/ui/layer-stack.js';",
      'const registerLayer = () => () => {};',
    )
    .replace(
      "import HelpTip from '../shared/ui/HelpTip.vue';",
      'const HelpTip = { template: "<span><slot /><slot name=\\"tip\\" /></span>" };',
    )
    .replace(
      "import { useUiStore } from '../stores/ui.js';",
      'const useUiStore = globalThis.__tgExpandUiStore;',
    )
    .replace(
      "import { useTasksStore } from '../stores/tasks.js';",
      'const useTasksStore = globalThis.__tgExpandTasksStore;',
    )
    .replace(
      "import { useBoardStore } from '../stores/board.js';",
      'const useBoardStore = globalThis.__tgExpandBoardStore;',
    )
    .replace(
      "import { useAnalysisStore } from '../stores/analysis.js';",
      'const useAnalysisStore = globalThis.__tgExpandAnalysisStore;',
    )
    .replace(
      "import { useTaskFavoritesStore } from '../stores/task-favorites.js';",
      'const useTaskFavoritesStore = globalThis.__tgExpandFavoritesStore;',
    )
    .replace(
      "import { useTaskSeenStore } from '../stores/task-seen.js';",
      'const useTaskSeenStore = globalThis.__tgExpandSeenStore;',
    )
    .replace(
      "import { liveTimerSec, secToHMS } from '../shared/format.js';",
      'const liveTimerSec = () => 0; const secToHMS = (n) => String(n ?? 0);',
    )
    .replace(
      "import { mdToHtml } from '../shared/md.js';",
      'const mdToHtml = (value) => String(value || "");',
    )
    .replace(
      "import { providerLabel } from '../shared/runner-display.js';",
      'const providerLabel = (id) => String(id || "");',
    )
    .replace(
      "import OpenDiffButton from './OpenDiffButton.vue';",
      'const OpenDiffButton = { template: "<span></span>" };',
    )
    .replace(
      "import TaskFavoriteButton from './board/TaskFavoriteButton.vue';",
      'const TaskFavoriteButton = { template: "<span></span>" };',
    );
  // Хвост `#nonce` обязателен: без него data:-модуль берётся из кэша загрузчика
  // (байты те же), и второе монтирование работает со сторами первого теста.
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${compileNonce}`
  )).default;
}

// Одно монтирование модалки на задаче с готовым полем `telegram`
// (именно в таком виде его отдаёт GET /api/b24/task/:id).
async function mountModal(t, task) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    FormData: browser.FormData,
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

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);

  globalThis.__tgExpandApi = {
    async get(url) {
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis.__tgExpandUiStore = defineStore(`tg-expand-ui-${compileNonce}`, {
    state: () => ({ taskId: 42 }),
    actions: { close() {} },
  });
  globalThis.__tgExpandTasksStore = defineStore(`tg-expand-tasks-${compileNonce}`, {
    actions: {
      async load() { return task; },
      async timer() {}, async complete() {}, async comment() {},
      async launch() { return {}; },
    },
  });
  globalThis.__tgExpandBoardStore = defineStore(`tg-expand-board-${compileNonce}`, {
    state: () => ({
      data: { tasks: [], toReview: [], created: [], accomplice: [], auditor: [] },
    }),
    actions: { async load() {} },
  });
  globalThis.__tgExpandAnalysisStore = defineStore(`tg-expand-analysis-${compileNonce}`, {
    actions: { async detail() { return {}; }, async analyze() {} },
  });
  globalThis.__tgExpandFavoritesStore = defineStore(`tg-expand-fav-${compileNonce}`, {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {}, async toggle() { return true; } },
  });
  globalThis.__tgExpandSeenStore = defineStore(`tg-expand-seen-${compileNonce}`, {
    state: () => ({ taskIds: [], loaded: true, initialized: true, error: null }),
    getters: { ready: () => true, isSeen: () => () => false },
    actions: { async load() { return true; }, async markSeen() { return true; } },
  });

  const pinia = createPinia();
  const TaskModal = await compileTaskModal();
  const wrapper = mount(TaskModal, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia] },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const key of [
      '__tgExpandApi', '__tgExpandUiStore', '__tgExpandTasksStore',
      '__tgExpandBoardStore', '__tgExpandAnalysisStore', '__tgExpandFavoritesStore',
      '__tgExpandSeenStore',
    ]) delete globalThis[key];
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

test('TG-UI-01: нераскрытая ссылка видна с причиной и без содержимого', async (t) => {
  const wrapper = await mountModal(t, {
    id: 42,
    title: 'Задача 42',
    description: 'Смотри https://t.me/c/1234567890/55',
    telegram: {
      links: [{
        url: 'https://t.me/c/1234567890/55',
        ok: false,
        reason: 'not_allowed',
        message: 'чат не привязан ни к одному проекту',
      }],
      text: '', quotes: 0, truncated: false,
    },
  });

  const block = wrapper.get('.tg');
  const text = block.text();
  assert.match(text, /Обсуждение в Telegram/);
  // Причина названа словами — молчание читалось бы как «в чате пусто».
  assert.match(text, /чат не привязан ни к одному проекту/);
  assert.match(text, /t\.me\/c\/1234567890\/55/);
  // Содержимого у отказа нет: ни цитат, ни имени чужого чата.
  assert.equal(block.findAll('.tgq').length, 0);
  assert.equal(block.findAll('.tghead').length, 0);
});

test('TG-UI-02: раскрытая ветка показывает чат, тему, цитаты и целевое сообщение', async (t) => {
  const wrapper = await mountModal(t, {
    id: 42,
    title: 'Задача 42',
    description: 'Обсуждали тут: https://t.me/example_team/100/55',
    telegram: {
      links: [{
        url: 'https://t.me/example_team/100/55',
        ok: true,
        chat: { title: 'Команда', username: 'team' },
        thread: 100,
        quotes: [
          {
            messageId: 54,
            at: 1770000000,
            author: 'Аня',
            text: 'Кнопка не нажимается на планшете',
            media: [],
            target: false,
            trimmed: false,
          },
          {
            messageId: 55,
            at: 1770000600,
            author: 'Борис',
            text: 'Вот скрин',
            media: ['фото', 'файл отчёт.pdf'],
            target: true,
            trimmed: false,
          },
        ],
        more: 3,
      }],
      text: '', quotes: 2, truncated: false,
    },
  });

  const block = wrapper.get('.tg');
  const head = block.get('.tghead').text();
  assert.match(head, /Команда/);
  assert.match(head, /@team/);
  assert.match(head, /тема 100/);

  const quotes = block.findAll('.tgq');
  assert.equal(quotes.length, 2);
  assert.match(quotes[0].text(), /Аня/);
  assert.match(quotes[0].text(), /Кнопка не нажимается на планшете/);
  assert.notEqual(quotes[0].get('.tgtime').text().trim(), '');

  // Целевое сообщение — то, на что показывала ссылка: помечено и видно глазом.
  assert.ok(quotes[1].classes().includes('tgtarget'));
  assert.match(quotes[1].text(), /← ссылка/);
  // Вложения сегодня словами: превью файлов — отдельная фаза плана.
  assert.match(quotes[1].text(), /фото/);
  assert.match(quotes[1].text(), /файл отчёт\.pdf/);

  // Хвост со склонением: «ещё 3 сообщения», а не «3 сообщение».
  assert.match(block.get('.tgmore').text(), /ещё\s*3\s*сообщения/);
});

test('TG-UI-03: без поля telegram блока нет вовсе', async (t) => {
  const wrapper = await mountModal(t, {
    id: 42,
    title: 'Задача 42',
    description: 'Обычная задача без ссылок',
  });
  assert.equal(wrapper.findAll('.tg').length, 0);
});

test('TG-UI-04: HTML из чужого чата не исполняется', async (t) => {
  const wrapper = await mountModal(t, {
    id: 42,
    title: 'Задача 42',
    description: 'ссылка https://t.me/example_team/1',
    telegram: {
      links: [{
        url: 'https://t.me/example_team/1',
        ok: true,
        chat: { title: '<img src=x onerror="globalThis.__tgPwned=1">', username: '' },
        thread: 0,
        quotes: [{
          messageId: 1,
          at: 1770000000,
          author: '<b>Аня</b>',
          text: '<script>globalThis.__tgPwned = 1;</script><img src=x onerror="globalThis.__tgPwned=1">',
          media: [],
          target: true,
          trimmed: false,
        }],
        more: 0,
      }],
      text: '', quotes: 1, truncated: false,
    },
  });

  const block = wrapper.get('.tg');
  assert.equal(block.findAll('img').length, 0);
  assert.equal(block.findAll('script').length, 0);
  assert.equal(block.findAll('b').length, 0);
  assert.equal(globalThis.__tgPwned, undefined);
  // Текст при этом виден как есть — экранирование, а не выбрасывание.
  assert.match(block.get('.tgtext').text(), /<img src=x/);
});

test('TG-UI-05: длинная цитата ограничена переносом, а не шириной колонки', async () => {
  // Статическая проверка: живого замера в офлайне нет (см. шапку файла).
  const source = await readFile(VIEW_PATH, 'utf8');
  const style = source.slice(source.indexOf('<style'));
  const rule = (selector) => {
    const at = style.indexOf(`${selector} {`);
    assert.ok(at > 0, `в <style scoped> нет правила ${selector}`);
    return style.slice(at, style.indexOf('}', at));
  };
  // Одно длинное слово (ссылка, лог, стек) не имеет права раздвинуть модалку.
  assert.match(rule('.tgtext'), /overflow-wrap:\s*anywhere/);
  // Флекс-элемент без min-width:0 не сжимается ниже своего содержимого —
  // ровно та грабля, что уже была в колонке чата.
  assert.match(rule('.tg'), /min-width:\s*0/);
  // Длинная ветка скроллится внутри блока, а не растягивает модалку вниз.
  assert.match(rule('.tg'), /overflow-y:\s*auto/);
});
