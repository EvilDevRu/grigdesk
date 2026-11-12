import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness as createSettingsHarness } from './helpers/settings-harness.js';
import { prepareI18nWindow } from './helpers/i18nComponent.js';
import { localeCorpus } from '../helpers/helpLocale.mts';

process.env.NODE_ENV = 'test';

/**
 * Vue запоминает document первого окна, в том числе назначение Teleport диалога.
 * Все проверки файла используют одно окно, очищая лишь его синтетический DOM.
 */
async function settingsHarness(t, pageId, component, options = {}) {
  const browser = await prepareI18nWindow();

  browser.document.body.innerHTML = '<div id="mount"></div>';

  return createSettingsHarness(t, pageId, component, { ...options, browser });
}


const corpus = {
  format: 1,
  version: '0.1.0',
  commit: 'c'.repeat(40),
  revision: 'd'.repeat(64),

  locale: 'ru',
  articles: [{
    id: 'overview',
    file: 'README.md',
    title: 'Начало',
    section: 'Основы',

    keywords: [],
    routes: [],
    markdown: '# Начало\nКак пользоваться справкой.'
  }]
};

test('HELP-WORK1: Ask создаёт новый draft и не отправляет модельный ход', async (t) => {
  const h = await settingsHarness(t, 'interface.behavior', 'HelpWorkspace');
  const auth = h.module.useAuthStore();
  const chat = h.module.useChatStore();

  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    h.control.handlers['/api/help'] = () => Response.json(corpus);
    chat.loaded = true;

    const previous = chat.newSession({
      title: 'Прежний', draft: 'МОЙ НЕОТПРАВЛЕННЫЙ ТЕКСТ'
    });

    auth.clientScope = 'fixture';
    auth.authenticated = true;
    await h.flushPromises();

    const ask = h.wrapper.findAll('button').find((button) => button.text() === 'Объяснить с агентом');

    assert.ok(ask);
    await ask.trigger('click');
    await h.flushPromises();

    const old = chat.sessions.find((entry) => entry.id === previous);
    const created = chat.sessions.find((entry) => entry.id === chat.activeId);

    assert.equal(old.draft, 'МОЙ НЕОТПРАВЛЕННЫЙ ТЕКСТ');
    assert.notEqual(created.id, old.id);
    assert.match(created.draft, /grigdesk_help/u);
    assert.match(created.draft, /overview/u);
    assert.match(created.draft, /0\.1\.0/u);
    assert.deepEqual(h.control.navigations, ['/chats']);
    assert.equal(h.control.calls.some((call) => call.method === 'POST' && call.path === '/api/chat'), false);
  } finally {
    chat.loaded = false;
    chat.$dispose();

    const callsBefore = h.control.calls.length;

    t.mock.timers.tick(1000);
    await h.flushPromises();
    assert.equal(h.control.calls.length, callsBefore);
  }
});
test('HELP-WORK2: F1 поверх незавершённых настроек не меняет поле и маршрут', async (t) => {
  const h = await settingsHarness(t, 'speech.dictation', 'SpeechPage');
  const help = h.module.useHelpStore();

  h.settings.setField('speech', 'dictionary', 'мой черновик словаря');

  const before = h.settings.snapshot.dirtyCount;
  const dispose = h.module.installHelpNavigation(h.browser, {
    currentRoute: {
      value: {
        path: '/projects'
      }
    }
  }, () => true);

  t.after(dispose);
  h.browser.dispatchEvent(new h.browser.KeyboardEvent('keydown', {
    code: 'F1', cancelable: true
  }));
  assert.equal(help.isOpen, true);
  assert.equal(help.articleId, 'speech');
  help.isOpen = false;
  assert.equal(h.settings.getValue('speech', 'dictionary'), 'мой черновик словаря');
  assert.equal(h.settings.snapshot.dirtyCount, before);
  assert.deepEqual(h.control.navigations, []);
  assert.equal(h.writes().length, 0);
});

test('HELP-WORK3: английские controls и явная русская статья', async (t) => {
  const h = await settingsHarness(t, 'interface.behavior', 'HelpBrowser', {
    props: {
      bundle: corpus,
      status: 'ready',
      articleId: 'overview'
    },
  });

  h.module.setUiLocale('en');
  t.after(() => h.module.setUiLocale('ru'));
  await h.flushPromises();
  assert.match(h.wrapper.text(), /The guide is currently available in Russian/u);
  assert.equal(h.wrapper.get('input[type="search"]').attributes('aria-label'), 'Search help');
  assert.match(h.wrapper.get('article').text(), /Начало/u);
});


test('HELP-KEEP-EN-RENDER: переданный EN корпус даёт свои TOC/search/related и unknown', async (t) => {
  const english = localeCorpus('en');
  const h = await settingsHarness(t, 'interface.behavior', 'HelpBrowser', {
    props: {
      bundle: english,
      status: 'ready',
      articleId: 'overview',
    },
  });

  h.module.setUiLocale('en');
  t.after(() => h.module.setUiLocale('ru'));
  await h.flushPromises();
  assert.match(h.wrapper.get('article').text(), /Guide/u);
  assert.match(h.wrapper.get('nav').text(), /Getting started/u);
  await h.wrapper.get('input[type="search"]').setValue('working directory');
  assert.match(h.wrapper.get('nav').text(), /Chat working directory/u);
  await h.wrapper.get('article a[href="#/help/chats"]').trigger('click');
  assert.deepEqual(h.wrapper.emitted('navigate')[0], ['chats', '']);
  await h.wrapper.setProps({ articleId: 'missing' });
  assert.equal(h.wrapper.find('.rich-md').exists(), false);
});

/**
 * Fetch обслуживает прежний URL и оба локализованных варианта настоящими JSON.
 * Язык меняет реальный адаптер, поэтому база показывает RU вместо EN без ошибки фикстуры.
 */
async function localeWorkspace(t, component = 'HelpWorkspace', options = {}) {
  const h = await settingsHarness(t, 'speech.dictation', component, {
    props: component === 'HelpWorkspace' ? { articleId: 'chats' } : {},
    stubs: component === 'HelpDialog' ? { teleport: true } : {},
  });

  h.control.handlers['/api/help'] = () => Response.json(localeCorpus('ru'));
  h.control.handlers['/api/help?locale=ru'] = () => Response.json(localeCorpus('ru'));
  h.control.handlers['/api/help?locale=en'] = () => Response.json(localeCorpus('en'));
  Object.defineProperty(h.browser.navigator, 'language', {
    value: options.system || 'ru-RU', configurable: true,
  });
  h.browser.localStorage.clear();

  const shell = h.module.useShellStore();

  if (options.shellSnapshot) {
    shell.apply(options.shellSnapshot);
  }

  const cleanup = h.module.localeAdapter.bootstrapUiLocale({
    window: h.browser,
    ...(options.shellSnapshot ? { shell } : {}),
  });

  t.after(() => {
    cleanup();
    h.module.setUiLocale('ru');
  });

  const auth = h.module.useAuthStore();

  auth.clientScope = 'locale-fixture';
  auth.authenticated = true;
  await h.flushPromises();

  return {
    ...h,
    auth,
    shell,
    adapter: h.module.localeAdapter,
  };
}

test('HELP-LW1: ru→en→ru сохраняет id, переводит TOC/search/related и ссылку сайта', async (t) => {
  const h = await localeWorkspace(t);

  assert.match(h.wrapper.get('article').text(), /Рабочая папка/u);
  await h.adapter.setUiLanguage('en');
  await h.flushPromises();
  assert.match(h.wrapper.get('article').text(), /Chat working directory/u);
  assert.equal(h.wrapper.props('articleId'), 'chats');
  assert.match(h.wrapper.get('nav').text(), /Getting started/u);
  assert.equal(h.control.calls.filter((call) => call.path === '/api/help?locale=en').length, 1);
  assert.ok(h.wrapper.findAll('a').some((link) =>
    /[?&]locale=en(?:&|#|$)/u.test(link.attributes('href') || '')));
  await h.wrapper.get('input[type="search"]').setValue('working directory');
  assert.match(h.wrapper.get('nav').text(), /Chat working directory/u);
  await h.wrapper.get('input[type="search"]').setValue('unfindable-sentinel');
  assert.match(h.wrapper.get('nav').text(), /nothing found|no results/iu);
  await h.wrapper.get('input[type="search"]').setValue('');
  await h.wrapper.get('article a[href="#/help/overview"]').trigger('click');
  assert.deepEqual(h.wrapper.emitted('navigate')[0], ['overview', '']);
  await h.adapter.setUiLanguage('ru');
  await h.flushPromises();
  assert.match(h.wrapper.get('article').text(), /Рабочая папка/u);
  assert.equal(h.control.calls.some((call) => call.path === '/api/help?locale=ru'), false);
});

for (const [system, expected] of [['ru-RU', 'ru'], ['en-US', 'en'], ['de-DE', 'en']]) {
  test(`HELP-LW1: system ${system} выбирает ${expected} и обновляет тот же chats`, async (t) => {
    const h = await localeWorkspace(t, 'HelpWorkspace', { system });

    assert.match(h.wrapper.get('article').text(), expected === 'en'
      ? /Chat working directory/u : /Рабочая папка/u);
    assert.equal(h.wrapper.props('articleId'), 'chats');
  });
}

test('HELP-LW2: обратные ответы разных scope/locale не смешивают identity и текст', async (t) => {
  const h = await localeWorkspace(t);
  let resolveOld;
  let rejectOld;
  const old = new Promise((resolve, reject) => {
    resolveOld = resolve;
    rejectOld = reject;
  });

  h.control.handlers['/api/help?locale=en'] = () => old;
  await h.adapter.setUiLanguage('en');
  await h.flushPromises();
  h.control.handlers['/api/help?locale=en'] = () => Response.json(localeCorpus('en', '0.2.0', 'SERVER-B'));
  h.auth.clientScope = 'server-b';
  await h.flushPromises();
  assert.match(h.wrapper.get('article').text(), /SERVER-B/u);
  resolveOld(Response.json(localeCorpus('en', '0.1.0', 'SERVER-A')));
  await h.flushPromises();
  assert.match(h.wrapper.get('article').text(), /SERVER-B/u);
  assert.doesNotMatch(h.wrapper.text(), /SERVER-A/u);

  h.control.handlers['/api/help?locale=en'] = () => new Promise((_, reject) => {
    rejectOld = reject;
  });
  h.auth.clientScope = 'server-c';
  await h.flushPromises();
  h.auth.authenticated = false;
  await h.flushPromises();
  rejectOld(new Error('Старый отказ'));
  await h.flushPromises();
  assert.equal(h.wrapper.find('article').exists(), false);
  assert.equal(h.module.useHelpStore().isOpen, false);
});

test('HELP-LW3: F1 и EN/legacy drafts сохраняют dirty/старый draft без POST', async (t) => {
  const h = await localeWorkspace(t, 'HelpDialog');
  const help = h.module.useHelpStore();
  const chat = h.module.useChatStore();

  chat.loaded = true;
  t.after(() => {
    chat.loaded = false;
    chat.$dispose();
  });

  const previous = chat.newSession({ title: 'Прежний', draft: 'НЕ ОТПРАВЛЯТЬ' });

  const speech = h.mount(h.module.SpeechPage, {
    props: { active: true },
    global: {
      plugins: [h.pinia],
      provide: h.wrapper.vm.$.appContext.provides,
    },
  });

  t.after(() => speech.unmount());
  await h.flushPromises();
  assert.equal(await h.settings.loadResource('speech'), true);
  h.settings.setField('speech', 'dictionary', 'грязный словарь');

  const dirty = h.settings.snapshot.dirtyCount;
  const pageId = h.settings.pageId;
  const dispose = h.module.installHelpNavigation(h.browser,
    { currentRoute: { value: { path: '/chats' } } }, () => true);

  t.after(dispose);
  h.browser.dispatchEvent(new h.browser.KeyboardEvent('keydown', { code: 'F1', cancelable: true }));
  await h.adapter.setUiLanguage('en');
  await h.flushPromises();
  assert.equal(help.isOpen, true);
  assert.equal(help.articleId, 'speech');

  // Контекст настроек выбирает speech: фикстура использует тот же id, что и навигация F1.
  help.articleId = 'chats';
  await h.flushPromises();

  for (const actualLocale of ['en', 'ru']) {
    if (actualLocale === 'ru') {
      h.control.handlers['/api/help?locale=en'] = () => Response.json(localeCorpus('ru'));
      h.auth.clientScope = 'legacy-server';
      help.isOpen = true;
      await h.flushPromises();
    }

    const ask = [...h.browser.document.querySelectorAll('button')]
      .find((button) => /Ask an agent|Объяснить с/u.test(button.textContent || ''));

    assert.ok(ask, 'Кнопка Ask доступна после F1 в открытом HelpDialog');
    ask.click();
    await h.flushPromises();

    const created = chat.sessions.find((entry) => entry.id === chat.activeId);

    assert.match(created.draft, new RegExp(`locale[^\\n]{0,12}${actualLocale}`, 'u'));
    assert.match(created.draft, /chats/u);
    assert.match(created.draft, /0\.1\.0/u);
    assert.equal(chat.sessions.find((entry) => entry.id === previous).draft, 'НЕ ОТПРАВЛЯТЬ');
  }

  help.isOpen = false;
  assert.equal(h.settings.getValue('speech', 'dictionary'), 'грязный словарь');
  assert.equal(h.settings.snapshot.dirtyCount, dirty);
  assert.equal(h.settings.pageId, pageId);
  assert.equal(h.control.calls.some((call) => call.method === 'POST' && call.path === '/api/chat'), false);
});

test('HELP-LW3: отказ записи языка возвращает RU корпус и отбрасывает поздний EN', async (t) => {
  const h = await localeWorkspace(t);
  let resolveEnglish;

  h.control.handlers['/api/help?locale=en'] = () => new Promise((resolve) => {
    resolveEnglish = resolve;
  });
  t.mock.method(h.browser.localStorage, 'setItem', () => {
    throw new Error('Отказ сохранения языка');
  });
  await h.adapter.setUiLanguage('en');
  await h.flushPromises();
  assert.equal(h.adapter.uiLanguage.value, 'system');
  assert.match(h.wrapper.get('article').text(), /Рабочая папка/u);
  assert.equal(typeof resolveEnglish, 'function', 'Мгновенный EN выбор действительно запустил чтение');
  resolveEnglish(Response.json(localeCorpus('en')));
  await h.flushPromises();
  assert.match(h.wrapper.get('article').text(), /Рабочая папка/u);
});

for (const mode of ['late-error', 'inflight-fallback']) {
  test(`HELP-LW2: shell systemLanguage, смена машины и ${mode} сохраняют весь bundle B`, async (t) => {
    const profile = {
      id: 'a',
      name: 'Машина А',
      kind: 'remote',
      address: 'https://a.example',
      status: 'online',
    };
    const snapshot = {
      rev: 1,
      profile,
      profiles: [profile],
      status: 'online',
      detail: null,
      localAvailable: false,
      serverApi: { major: 0, minor: 1 },
      appApi: { major: 0, minor: 1 },
      capabilities: [],
      locale: { preference: 'system', systemLanguage: 'en-US' },
    };
    const h = await localeWorkspace(t, 'HelpWorkspace', { shellSnapshot: snapshot });
    const help = h.module.useHelpStore();
    const dispose = h.module.bindHelpAccess(h.auth, h.shell, () => help.close());

    t.after(dispose);
    assert.match(h.wrapper.get('article').text(), /Chat working directory/u);

    const old = Promise.withResolvers();
    const latest = localeCorpus('en', '0.2.0', 'SERVER-B');

    if (mode === 'late-error') {
      h.control.handlers['/api/help?locale=en'] = () => old.promise;
    } else {
      h.control.handlers['/api/help?locale=en'] = () => Response.json({
        error: 'help_locale_unavailable', locale: 'en',
      }, { status: 404 });
      h.control.handlers['/api/help'] = () => old.promise;
      h.control.handlers['/api/help?locale=ru'] = () => old.promise;
    }

    h.auth.clientScope = 'a-pending';
    await h.flushPromises();

    const ruBefore = h.control.calls.filter((call) => call.path === '/api/help'
      || call.path === '/api/help?locale=ru').length;

    h.control.handlers['/api/help?locale=en'] = () => Response.json(latest);
    help.open('chats');
    h.shell.apply({
      ...snapshot,
      rev: 2,
      profile: { ...profile, id: 'b' },
    });
    assert.equal(help.isOpen, false);
    await h.flushPromises();
    assert.deepEqual(h.wrapper.findComponent(h.module.HelpBrowser).props('bundle'), latest);

    if (mode === 'late-error') {
      old.resolve(Response.json({ error: 'help_locale_unavailable', locale: 'en' }, { status: 404 }));
    } else {
      old.resolve(Response.json(localeCorpus('ru', '0.1.0', 'SERVER-A')));
    }

    await h.flushPromises();
    assert.deepEqual(h.wrapper.findComponent(h.module.HelpBrowser).props('bundle'), latest);
    assert.equal(h.control.calls.filter((call) => call.path === '/api/help'
      || call.path === '/api/help?locale=ru').length, ruBefore);
    assert.equal(h.adapter.uiLanguage.value, 'system');
    h.auth.authenticated = false;
    assert.equal(help.isOpen, false);
    await h.flushPromises();
    assert.equal(h.wrapper.find('article').exists(), false);
    h.auth.authenticated = true;
    await h.flushPromises();
    assert.equal(help.isOpen, false);
    assert.deepEqual(h.wrapper.findComponent(h.module.HelpBrowser).props('bundle'), latest);
  });
}
