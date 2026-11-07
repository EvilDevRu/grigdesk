import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

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
