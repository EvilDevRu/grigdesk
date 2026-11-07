import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { api } from '../../web/src/shared/apiClient.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { chatListPagingStub } from './helpers/chat-list.js';

process.env.NODE_ENV = 'test';

let browser;
let vue;
let mount;
let ChatList;
let sse;
let locale;

const sources = [];
const providers = ['claude', 'codex', 'kimi', 'deepseek', 'glm'];
const tasks = [{
  id: 'agent',
  kind: 'subagent',
  description: 'Проверяет документ',
}];

/**
 * Подменён только сетевой EventSource: подписку и connected ведёт настоящий useSse.
 * Поэтому два списка разделяют один поток, а disconnect проходит через публичный lifecycle.
 */
class Source {
  constructor() {
    this.listeners = new Map();
    this.closed = false;
    sources.push(this);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  close() {
    this.closed = true;
  }

  emit(name, data = {}) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) });
  }
}

before(async () => {
  browser = await installUiBrowser({ after: (cleanup) => after(cleanup) });
  vue = await import('../../web/node_modules/vue/index.mjs');
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
  sse = await import('../../web/src/composables/useSse.ts');
  locale = await import('../../web/src/services/locale.ts');

  Object.defineProperty(globalThis, 'EventSource', { value: Source, configurable: true });

  globalThis.__sleepSse = sse;
  globalThis.__sleepLocale = locale;

  const sseExport = 'export const { useSse, sseSubscribe } = globalThis.__sleepSse;';
  const localeExport = `export const {
    uiLocale, setUiLocale, snapshotText, t, resolveUiText, messageRef, locales,
  } = globalThis.__sleepLocale;`;

  ChatList = await compileVue(webFile('src/views/chat/ChatList.vue'), {
    stubs: {
      '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__sleepChat;',
      '../../stores/providers.ts': 'export const useProvidersStore = () => globalThis.__sleepProviders;',
      './useSse.ts': sseExport,
      './useSse': sseExport,
      '../../composables/useSse.ts': sseExport,
      './services/locale.ts': localeExport,
      '../services/locale.ts': localeExport,
      '../../shared/ProviderIcon.vue': `export default {
        props: ['provider', 'size'], template: '<i class="pico"></i>',
      };`,
    },
  });
});

after(async () => {
  sse?.resetSseForTests();
  await browser?.close();
});

/**
 * Vue завершает цепочку mount → GET → computed без ожидания настоящей сети или таймеров.
 * Проверки читают только DOM и запросы, не внутренние refs нового composable.
 */
async function settle() {
  await setImmediate();
  await vue.nextTick();
  await setImmediate();
  await vue.nextTick();
}

function session(overrides = {}) {
  return {
    chatKey: 'chat-claude',
    alive: true,
    sleeping: true,
    backgroundTasks: structuredClone(tasks),
    running: false,
    ...overrides,
  };
}

function badge(wrapper) {
  return wrapper.findAll('.ava [data-ui-tooltip]').find((target) =>
    /Агент спит|agent.*sleep/iu.test(target.attributes('data-ui-tooltip')));
}

const hasBadge = (wrapper) => Boolean(badge(wrapper));

/**
 * Настоящий ChatList и UI primitives получают реактивные строки, каталог и серверный ответ.
 * Все GET перехвачены: даже ошибочная фикстура не обратится к живой папке или сервису.
 */
async function fixture(t, { defer = false, sessions = [session()] } = {}) {
  sse.resetSseForTests();
  sources.length = 0;
  locale.setUiLocale('ru');

  const requests = [];
  const wrappers = [];
  const selected = [];
  const renamed = [];
  const state = vue.reactive({
    ...chatListPagingStub(),
    loaded: true,
    loading: false,
    loadError: null,
    activeId: '',
    archived: [],
    rows: providers.map((provider) => ({
      id: `chat-${provider}`,
      title: `Разговор ${provider}`,
      snippet: 'Последняя реплика',
      ts: Date.now(),
      model: provider,
      sending: false,
      compacting: false,
      unread: false,
      waiting: false,
    })),
    list(query, archived) {
      return this.rows.filter((row) => Boolean(row.archived) === archived && row.title.includes(query));
    },
    selectChat(id) {
      selected.push(id);
      this.activeId = id;
    },
    renameChat(id, title) {
      renamed.push({ id, title });
    },
    newSession() {},
    deleteChat() {},
    restoreArchived() {},
  });
  const server = {
    sessions,
    defer,
    error: null,
  };

  globalThis.__sleepChat = state;
  globalThis.__sleepProviders = {
    load() {},
    modelOf(id) {
      return { model: { name: id }, provider: {
        id,
        name: id,
        color: '#d97757',
      } };
    },
  };
  t.mock.method(api, 'get', (url, options) => {
    assert.equal(url, '/api/chat/sessions', 'единственный ресурс проекции сна');

    return new Promise((resolve, reject) => {
      requests.push({
        resolve,
        reject,
        signal: options?.signal,
      });

      if (!server.defer) {
        if (server.error) {
          reject(server.error);
        } else {
          resolve({ sessions: structuredClone(server.sessions) });
        }
      }
    });
  });
  t.after(async () => {
    for (const wrapper of wrappers) {
      if (wrapper.exists()) {
        wrapper.unmount();
      }
    }

    sse.resetSseForTests();
    locale.setUiLocale('ru');
    await settle();
  });

  /**
   * Каждое монтирование независимо получает серверную проекцию и собственную подписку.
   * DOM крепится к отдельному узлу, чтобы второе окно не уничтожало первое.
   */
  async function mountList() {
    const target = browser.document.createElement('div');

    browser.document.body.append(target);

    const wrapper = mount(ChatList, { attachTo: target });

    wrappers.push(wrapper);

    const source = sources.at(-1);

    if (source && !source.opened) {
      source.opened = true;
      source.onopen?.();
    }

    await settle();

    return wrapper;
  }

  /**
   * Событие проходит через общий singleton SSE, а ответ GET остаётся управляемым тестом.
   * При отсутствии нового потребителя это безопасный no-op, а затем падает assertion поведения.
   */
  async function emit(name, data = {}) {
    sources.at(-1)?.emit(name, data);
    await settle();
  }

  return {
    state,
    requests,
    selected,
    renamed,
    server,
    mountList,
    emit,
  };
}

for (const editing of [false, true]) {
  test(`LIST-BASE-01: кольцо, подписи, непрочитанное и действия; переименование=${editing}`, async (t) => {
    const f = await fixture(t, { sessions: [] });
    const wrapper = await f.mountList();
    const row = f.state.rows[0];

    await wrapper.find('.row-hit').trigger('click');
    assert.deepEqual(f.selected, ['chat-claude']);
    assert.equal(wrapper.emitted('open').length, 1);

    if (editing) {
      await wrapper.find('.row-hit').trigger('dblclick');
    }

    row.sending = true;
    await settle();
    assert.equal(wrapper.find('.ava').classes().includes('live'), true);
    assert.match(wrapper.find('.ava').attributes('data-ui-tooltip'), /агент работает/);
    row.compacting = true;
    await settle();
    assert.equal(wrapper.find('.ava').classes().includes('live'), true);
    assert.match(wrapper.find('.ava').attributes('data-ui-tooltip'), /сжимаю контекст/);
    row.sending = false;
    row.compacting = false;
    row.unread = true;
    row.waiting = true;
    await settle();
    assert.equal(wrapper.find('.ava').classes().includes('live'), false);
    assert.equal(wrapper.find('.udot').exists(), true);
    assert.equal(hasBadge(wrapper), false, 'без серверного сна у всех пяти исполнителей прежний вид');

    if (editing) {
      await wrapper.find('input[aria-label="Название чата"]').setValue('Новое название');
      await wrapper.find('input[aria-label="Название чата"]').trigger('keydown', { key: 'Enter' });
      assert.deepEqual(f.renamed, [{ id: row.id, title: 'Новое название' }]);
    }

    assert.equal(wrapper.find('.wchip').text(), 'ждёт ответа');
    assert.equal(wrapper.findAll('.ava').length, 5);
    assert.equal(wrapper.find('.row-hit button').exists(), false);
  });
}

test('LIST-MEMO-01: копия строк сохраняет DOM, видимые поля и редактор обновляются', async (t) => {
  const f = await fixture(t, { sessions: [] });
  const catalog = vue.reactive(Object.fromEntries(providers.map((id) => [id, {
    model: { name: id },
    provider: { id, color: '#d97757' },
  }])));

  globalThis.__sleepProviders.modelOf = (id) => catalog[id];

  const wrapper = await f.mountList();
  const element = wrapper.find('.row').element;

  f.state.rows = f.state.rows.map((row) => ({ ...row }));
  await settle();
  assert.equal(wrapper.find('.row').element, element);

  const row = f.state.rows[0];

  row.title = 'Изменённое название';
  row.snippet = 'Изменённое превью';
  row.draft = true;
  row.ts = Date.now() - 120_000;
  row.model = 'codex';
  await settle();
  assert.equal(wrapper.find('.name').text(), row.title);
  assert.ok(wrapper.find('.t2').text().includes(row.snippet));
  assert.equal(wrapper.find('.dr').exists(), true);
  assert.equal(wrapper.find('.ago').text(), '2м');
  assert.equal(wrapper.find('.mdl').text(), 'codex');
  catalog.codex.provider.color = '';
  await settle();
  assert.equal(wrapper.find('.ava').classes().includes('brand'), false);
  await wrapper.find('.row-hit').trigger('click');
  await settle();
  assert.equal(wrapper.find('.row').classes().includes('cur'), true);
  await wrapper.find('.row-hit').trigger('dblclick');
  await settle();

  const input = wrapper.find('input[aria-label="Название чата"]');

  await input.setValue('Новое имя из редактора');
  await settle();
  assert.equal(input.element.value, 'Новое имя из редактора');
  await input.trigger('keydown', { key: 'Enter' });
  assert.deepEqual(f.renamed, [{ id: row.id, title: 'Новое имя из редактора' }]);
});

test('LIST-SLEEP-01: знак сна в двух аватарах скрывается при ходе, сжатии, [] и смерти', async (t) => {
  const f = await fixture(t);
  const wrapper = await f.mountList();
  const row = f.state.rows[0];

  row.unread = true;
  await settle();
  assert.equal(hasBadge(wrapper), true, 'спящая строка получила отдельный знак');
  assert.equal(wrapper.find('.udot').exists(), true, 'непрочитанное остаётся независимым');
  assert.equal(wrapper.find('.ava.live').exists(), false);
  assert.equal(wrapper.findAll('.ava').slice(1).some((avatar) => hasBadge(avatar)), false);

  const target = badge(wrapper);

  assert.equal(target.attributes('title'), undefined, 'подсказка использует общую директиву');
  assert.equal(Boolean(target.attributes('aria-label') || target.attributes('aria-description')), true);
  assert.equal(target.element.tagName === 'BUTTON', false, 'значок пассивен');
  assert.equal(target.element.tagName.toLowerCase() === 'svg' || target.find('svg').exists(), true,
    'неподвижный знак Zz нарисован простой SVG-графикой');
  await wrapper.find('.row-hit').trigger('dblclick');
  assert.equal(hasBadge(wrapper), true, 'переименование сохраняет тот же сон');
  row.sending = true;
  await settle();
  assert.equal(hasBadge(wrapper), false);
  assert.equal(wrapper.find('.ava.live').exists(), true);
  row.compacting = true;
  await settle();
  assert.equal(hasBadge(wrapper), false);
  assert.match(wrapper.find('.ava').attributes('data-ui-tooltip'), /сжимаю контекст/);
  row.sending = false;
  row.compacting = false;
  await settle();
  assert.equal(hasBadge(wrapper), true);
  f.server.sessions = [session({ sleeping: false, backgroundTasks: [] })];
  await f.emit('chat-sessions');
  assert.equal(hasBadge(wrapper), false);
  f.server.sessions = [session()];
  await f.emit('chat-sessions');
  assert.equal(hasBadge(wrapper), true);
  f.server.sessions = [session({ alive: false })];
  await f.emit('chat-sessions');
  assert.equal(hasBadge(wrapper), false, 'мёртвый процесс больше не обещает пробуждения');
  f.server.sessions = [];
  await f.emit('chat-sessions');
  assert.equal(hasBadge(wrapper), false);
});

for (const count of [1, 2, 5]) {
  test(`LIST-SLEEP-02: RU/EN, plural=${count}, описания остаются текстом`, async (t) => {
    const active = ['subagent', 'monitor', 'command', 'other'].flatMap((kind) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${kind}-${index}`,
        kind,
        description: index === 0 ? `${kind}: <b>core.cores</b>` : `${kind}: описание ${index}`,
      })));

    active.at(-1).description = '';

    const f = await fixture(t, {
      sessions: [session({
        backgroundTasks: active,
        ambientTasks: [{ description: 'СКРЫТЫЙ ambient' }],
        awaitedTasks: [{ description: 'СКРЫТЫЙ awaited' }],
      })],
    });
    const wrapper = await f.mountList();

    assert.equal(hasBadge(wrapper), true);

    const ru = badge(wrapper).attributes('data-ui-tooltip');
    const subagents = {
      1: 'субагент',
      2: 'субагента',
      5: 'субагентов',
    };
    const monitors = {
      1: 'монитор',
      2: 'монитора',
      5: 'мониторов',
    };
    const commands = {
      1: 'команда',
      2: 'команды',
      5: 'команд',
    };

    assert.match(ru, /Агент спит — ждёт фоновые задачи/);
    assert.match(ru, new RegExp(`${count} ${subagents[count]}(?:\\s|:|$)`));
    assert.match(ru, new RegExp(`${count} ${monitors[count]}(?:\\s|:|$)`));
    assert.match(ru, new RegExp(`${count} (?:фоновая |фоновые |фоновых )?${commands[count]}(?:\\s|:|$)`));
    assert.match(ru, /(?:проч|друг).{0,15}задач/iu, 'прочие задачи тоже имеют переведённый счётчик');
    assert.match(ru, /Без описания/);

    for (const task of active.filter((task) => task.description)) {
      assert.equal(ru.includes(task.description), true);
    }

    assert.doesNotMatch(ru, /СКРЫТЫЙ/);
    assert.equal(wrapper.find('.ava b').exists(), false, 'HTML-подобное описание не стало разметкой');
    locale.setUiLocale('en');
    await settle();

    const en = badge(wrapper).attributes('data-ui-tooltip');
    const suffix = count === 1 ? '' : 's';

    assert.match(en, /agent.*sleep/iu);
    assert.match(en, new RegExp(`${count} subagent${suffix}(?:\\s|:|$)`, 'iu'));
    assert.match(en, new RegExp(`${count} monitor${suffix}(?:\\s|:|$)`, 'iu'));
    assert.match(en, new RegExp(`${count} (?:background )?command${suffix}(?:\\s|:|$)`, 'iu'));
    assert.match(en, /other.*task/iu);
    assert.match(en, /(?:no|without) description/iu);

    for (const task of active.filter((task) => task.description)) {
      assert.equal(en.includes(task.description), true, 'описания не переводятся вместе с интерфейсом');
    }

    assert.doesNotMatch(en, /СКРЫТЫЙ/);
    assert.equal(wrapper.find('.ava b').exists(), false);
  });
}

test('LIST-LOAD-01: mount, второе окно и повторный mount читают сервер; hello перечитывает', async (t) => {
  const f = await fixture(t);
  const first = await f.mountList();

  assert.ok(f.requests.length > 0, 'список запрашивает серверную проекцию на mount');
  assert.equal(hasBadge(first), true);

  const beforeSecond = f.requests.length;
  const second = await f.mountList();

  assert.ok(f.requests.length > beforeSecond);
  assert.equal(hasBadge(second), true);
  assert.equal(sources.length, 1, 'оба списка используют общий SSE');
  first.unmount();

  const remounted = await f.mountList();

  assert.equal(hasBadge(remounted), true, 'F5 берёт сон с сервера, а не из истории чата');
  f.server.sessions = [];
  await f.emit('hello', { bootId: 'server-boot-0002' });
  assert.equal(hasBadge(second), false);
  assert.equal(hasBadge(remounted), false);
  f.server.sessions = [session({ running: true })];
  await f.emit('chat-sessions');
  assert.equal(hasBadge(remounted), true, 'HTTP running публикации не заменяет серверный sleeping');
});

test('LIST-LOAD-02: закрытие во время GET объединяет события и перечитывает последний снимок', async (t) => {
  const f = await fixture(t, { defer: true });
  const wrapper = await f.mountList();

  assert.equal(f.requests.length, 1, 'mount начал GET, ответа ещё нет');
  await f.emit('chat-sessions');
  await f.emit('chat-sessions');
  await f.emit('chat-sessions');
  f.requests[0].resolve({ sessions: [session()] });
  await settle();

  assert.equal(f.requests.length, 2, 'invalidation не потерян и объединён в один повтор');
  assert.equal(hasBadge(wrapper), false, 'устаревший снимок не обещает пробуждение');
  f.requests[1].resolve({ sessions: [] });
  await settle();
  assert.equal(hasBadge(wrapper), false);
});

test('LIST-LOAD-02: старый ответ после hello нового сервера и unmount не возвращает сон', async (t) => {
  const f = await fixture(t, { defer: true });
  const wrapper = await f.mountList();

  assert.equal(f.requests.length, 1);
  await f.emit('hello', { bootId: 'server-boot-0002' });
  f.requests[0].resolve({ sessions: [session()] });
  await settle();

  assert.equal(hasBadge(wrapper), false);
  assert.ok(f.requests.length >= 2, 'новый сервер требует свежий GET');

  const current = f.requests.at(-1);

  wrapper.unmount();

  const before = f.requests.length;

  await f.emit('chat-sessions');
  assert.equal(f.requests.length, before, 'unmount удалил подписку');
  assert.equal(current.signal?.aborted, true, 'unmount отменил свой запрос');
  current.resolve({ sessions: [session()] });
  await settle();
  f.server.defer = false;
  f.server.sessions = [];

  const next = await f.mountList();

  assert.equal(hasBadge(next), false, 'ответ снятого экземпляра не передан новому списку');
});

test('LIST-LOAD-03: disconnect и ошибка скрывают сон, reconnect восстанавливает свежий снимок', async (t) => {
  const f = await fixture(t);
  const wrapper = await f.mountList();

  assert.equal(hasBadge(wrapper), true);
  sources.at(-1)?.onerror?.();
  await settle();
  assert.equal(hasBadge(wrapper), false);
  sse.setSseEnabled(false);
  sse.setSseEnabled(true);
  sources.at(-1)?.onopen?.();
  await f.emit('hello', { bootId: 'server-boot-0001' });
  assert.equal(hasBadge(wrapper), true);
  f.server.error = new Error('Синтетическая ошибка GET');
  await f.emit('chat-sessions');
  assert.equal(hasBadge(wrapper), false);
  f.server.error = null;
  await f.emit('hello', { bootId: 'server-boot-0001' });
  assert.equal(hasBadge(wrapper), true);
  f.server.sessions = [{
    chatKey: 'chat-claude',
    alive: true,
    running: false,
  }];
  await f.emit('chat-sessions');
  assert.equal(hasBadge(wrapper), false, 'старый сервер без полей сна не создаёт метку');
});
