import assert from 'node:assert/strict';
import test from 'node:test';

import { i18nComponent } from './helpers/i18nComponent.js';
import { settingsResource } from './helpers/settings-session.js';
import { catalogMessage } from './helpers/i18nCatalog.js';
import { directSshSetting } from '../../server/src/lib/executors/_directSshPolicy.ts';
import data from './fixtures/settings-modal/data.json' with { type: 'json' };
import native from '../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };

process.env.NODE_ENV = 'test';

const pages = [
  'interface.behavior', 'interface.notifications', 'interface.shortcuts',
  'automation.chats', 'automation.context', 'automation.launch', 'automation.monitoring',
  'automation.arbiter', 'agents.models', 'connections.devices', 'connections.b24',
  'connections.mobile', 'system.startup', 'system.updates', 'system.processes',
  'plugins.install', 'plugins.installed', 'agents.providers', 'speech.dictation',
  'speech.video', 'speech.language', 'speech.models', 'speech.advanced', 'system.diagnostics',
];

/**
 * Сторонние имена, значения и документация синтетических DTO остаются raw по К8.
 * После их вычитания собственные подписи страницы, ARIA и hints обязаны быть английскими.
 */
function ownText(element) {
  const raw = [];

  /**
   * Содержимое DTO вычитается целиком, включая внешние описания и имена.
   * Сборщик не содержит списка русских UI-надписей и не заменяет их перевод.
   */
  function collect(value) {
    if (typeof value === 'string') {
      raw.push(value);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(collect);
    }
  }

  collect(data);
  collect(native);

  const content = element.cloneNode(true);

  // Самоназвания языков неизменны по К2 и уже проверены буквально в I18N-S01.
  // Исключение относится только к option русского языка, а не к прочим подписям.
  const languageOptions = content.querySelectorAll(
    'select[aria-label="Interface language"] option[value="ru"]');

  for (const option of languageOptions) {
    assert.equal(option.textContent, 'Русский');
    option.remove();
  }

  // ProviderIcon показывает первую букву исходного имени из того же DTO.
  // Вычитаем только этот текст значка, сохраняя проверку его доступных подписей.
  const providerInitials = new Set(data.providers.providers
    .map((provider) => (provider.name || '?')[0].toUpperCase()));

  for (const icon of content.querySelectorAll('span.fb')) {
    assert.equal(providerInitials.has(icon.textContent.trim()), true,
      'Инициал ProviderIcon происходит из имени исполнителя в DTO');
    icon.textContent = '';
  }

  let text = content.textContent;

  for (const node of content.querySelectorAll('[aria-label], [placeholder], option, optgroup')) {
    text += ' ' + [node.getAttribute('aria-label'), node.getAttribute('placeholder'),
      node.getAttribute('label')].filter(Boolean).join(' ');
  }

  for (const value of raw.sort((left, right) => right.length - left.length)) {
    if (value) {
      text = text.replaceAll(value, '');
    }
  }

  return text;
}

/**
 * Поле языка ищется по доступной подписи, так же как его находит человек.
 * Отсутствующий control даёт RED К2 до обращения к будущему API адаптера.
 */
function languageControl(wrapper) {
  const control = wrapper.findAll('select').find((item) =>
    ['Язык интерфейса', 'Interface language'].includes(item.attributes('aria-label')));

  assert.equal(Boolean(control), true, 'К2: есть доступный выбор языка интерфейса');

  return control;
}

/**
 * Реальная страница регистрирует device-ресурсы в живой сессии настроек.
 * Тест не подменяет немедленное сохранение и не вызывает общий Apply.
 */
async function interfacePage(t, options = {}) {
  const h = await i18nComponent(t, options);

  h.settings.setAuthenticated(true);
  h.settings.requestOpen({ pageId: 'interface.behavior' });

  const wrapper = h.mount(h.module.InterfacePage, {
    attachTo: document.body,
    props: { active: true },
    global: { plugins: [h.pinia] },
  });

  t.after(() => wrapper.unmount());
  await h.flushPromises();

  return { ...h, wrapper };
}

test('I18N-S01: system/ru/en, немедленный выбор, Cancel и прежний dirty-контекст', async (t) => {
  const h = await interfacePage(t);
  const resource = settingsResource('language-neighbour', { draft: 'до' });

  h.settings.registerResource(resource.adapter, resource.fields);
  await h.settings.loadResource('language-neighbour');
  h.settings.setField('language-neighbour', 'draft', 'черновик');
  h.settings.query = 'language-query';

  const control = languageControl(h.wrapper);

  assert.equal(control.element.value, 'system');
  assert.deepEqual(control.findAll('option').map((item) => [item.attributes('value'), item.text()]), [
    ['system', 'Как в системе'], ['ru', 'Русский'], ['en', 'English'],
  ]);

  const dirty = h.settings.snapshot.dirtyCount;

  await control.setValue('en');
  await h.flushPromises();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(languageControl(h.wrapper).attributes('aria-label'), 'Interface language');
  assert.deepEqual(languageControl(h.wrapper).findAll('option').map((item) => item.text()), [
    'System default', 'Русский', 'English',
  ]);
  assert.equal(h.settings.snapshot.dirtyCount, dirty);
  assert.equal(h.settings.getValue('language-neighbour', 'draft'), 'черновик');
  assert.equal(h.settings.pageId, 'interface.behavior');
  assert.equal(h.settings.query, 'language-query');
  assert.equal(resource.calls.writes.length, 0);
  assert.equal(localStorage.getItem('grigdesk-ui-language'), 'en');
  h.settings.cancel();
  await h.flushPromises();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(localStorage.getItem('grigdesk-ui-language'), 'en');
});

test('I18N-S02: все 24 страницы, публичные метаданные, EN/RU поиск и сохранение значений', async (t) => {
  const h = await i18nComponent(t);

  assert.deepEqual(Object.keys(h.module.SETTINGS_PAGE_COMPONENTS).sort(), [...pages].sort());
  h.settings.setAuthenticated(true);
  h.settings.requestOpen({ pageId: 'interface.behavior' });

  const wrapper = h.mount(h.module.SettingsModal, {
    attachTo: document.body,
    global: { plugins: [h.pinia], stubs: { transition: false } },
  });

  t.after(() => wrapper.unmount());
  await h.flushPromises();
  await h.module.localeAdapter.setUiLanguage('en');

  for (const pageId of pages) {
    h.settings.selectPage(pageId);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await h.flushPromises();
    }

    const title = document.querySelector('#settings-page-title')?.textContent || '';

    assert.match(title, /[A-Za-z]/, pageId);
    assert.doesNotMatch(title, /[А-Яа-яЁё]/, pageId);

    const intro = document.querySelector('.settings-page-intro')?.textContent || '';

    assert.doesNotMatch(intro, /[А-Яа-яЁё]/, `${pageId}: описание`);
    assert.equal(document.querySelector('.settings-page-loading'), null, pageId);
    assert.doesNotMatch(ownText(document.querySelector('.settings-page-area')), /[А-Яа-яЁё]/, pageId);
    assert.doesNotMatch(ownText(document.querySelector('.settings-page-area')),
      /\bsettings\.[a-z]+\./, pageId);
    assert.equal(h.settings.pageId, pageId);
  }

  h.settings.selectPage('connections.devices');
  await h.flushPromises();

  const name = new h.DOMWrapper(document.querySelector('.settings-devices input'));

  await name.setValue('Мой ноутбук');

  const adding = await catalogMessage('settings', 'Добавить устройство');
  const add = [...document.querySelectorAll('[role="dialog"] button')]
    .map((button) => new h.DOMWrapper(button))
    .find((button) => button.text() === adding.en);

  assert.equal(Boolean(add), true);
  await add.trigger('click');
  await h.flushPromises();

  const pairing = [...document.querySelectorAll('[role="dialog"]')].at(-1);

  assert.doesNotMatch(pairing.textContent, /[А-Яа-яЁё]/);

  const close = [...pairing.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Close');

  assert.equal(Boolean(close), true);
  close.click();
  await h.flushPromises();
  h.settings.query = 'keyboard';
  await h.flushPromises();
  assert.match(document.querySelector('.settings-results')?.textContent || '', /[Kk]eyboard|[Ss]hortcut/);
  await h.module.localeAdapter.setUiLanguage('ru');
  h.settings.query = 'клавиши';
  await h.flushPromises();
  assert.match(document.querySelector('.settings-results')?.textContent || '', /Сочетания клавиш/);
  assert.equal(name.element.value, 'Мой ноутбук');
  assert.equal(h.calls.filter((call) => call.method && call.method !== 'GET').length, 0);
});

test('I18N-S03: неверный storage, отказ записи и защита optimistic выбора от старого poll', async (t) => {
  let pending = Promise.withResolvers();
  let shell;
  const snapshot = {
    rev: 3,
    profile: null,
    profiles: [],
    status: 'none',
    detail: null,
    localAvailable: false,
    capabilities: [],
    locale: { preference: 'system', systemLanguage: 'ru-RU' },
  };
  const h = await interfacePage(t, {
    prepareWindow(win) {
      win.localStorage.setItem('grigdesk-ui-language', 'unsupported');
    },
    bootstrap(module, pinia) {
      shell = module.useShellStore(pinia);
      shell.apply(snapshot);

      return { shell };
    },
    fetch(url) {
      assert.equal(String(url), '/__shell/locale');

      return pending.promise;
    },
  });
  const control = languageControl(h.wrapper);

  assert.equal(control.element.value, 'system');
  await control.setValue('en');
  await h.nextTick();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(languageControl(h.wrapper).element.disabled, true);
  shell.apply({ ...snapshot, rev: 4 });
  await h.nextTick();
  assert.equal(document.documentElement.lang, 'en');
  pending.resolve(new Response(JSON.stringify({
    error: 'test_save_failure',
    message: 'Сохранение отклонено',
  }), {
    status: 500,
  }));
  await h.flushPromises();
  assert.equal(languageControl(h.wrapper).element.value, 'system');
  assert.equal(document.documentElement.lang, 'ru');
  assert.equal(languageControl(h.wrapper).element.disabled, false);
  assert.match(h.wrapper.text(), /Сохранение отклонено|Не удалось сохранить/);
  assert.equal(h.calls.filter((call) => call.pathname === '/__shell/locale').length, 1);

  pending = Promise.withResolvers();
  await languageControl(h.wrapper).setValue('en');
  await h.nextTick();
  shell.apply({ ...snapshot, rev: 5 });
  await h.nextTick();
  assert.equal(document.documentElement.lang, 'en');
  pending.resolve(new Response(JSON.stringify({
    ...snapshot,
    rev: 6,
    locale: { preference: 'en', systemLanguage: 'ru-RU' },
  })));
  await h.flushPromises();
  assert.equal(languageControl(h.wrapper).element.value, 'en');
  shell.apply({ ...snapshot, rev: 4 });
  await h.nextTick();
  assert.equal(document.documentElement.lang, 'en');
});

test('I18N-S03/storage: ошибка localStorage не роняет UI и не выдаётся за сохранение', async (t) => {
  const h = await interfacePage(t, {
    prepareWindow(win) {
      t.mock.method(win.localStorage, 'setItem', () => {
        throw new Error('Тестовый отказ сохранения');
      });
    },
  });

  await languageControl(h.wrapper).setValue('en');
  await h.flushPromises();
  assert.equal(languageControl(h.wrapper).element.value, 'system');
  assert.match(h.wrapper.text(), /сохран|Тестовый отказ/i);
});

test('I18N-S03/read: недоступное хранилище не мешает первому показу настроек', async (t) => {
  const h = await interfacePage(t, {
    prepareWindow(win) {
      t.mock.method(win.localStorage, 'getItem', () => {
        throw new Error('Тестовый отказ чтения storage');
      });
    },
  });

  assert.equal(languageControl(h.wrapper).element.value, 'system');
  assert.equal(document.documentElement.lang, 'ru');
});

test('I18N-S04: после English локальная проверка речи auto по-прежнему запрашивает ru', async (t) => {
  const h = await interfacePage(t);
  const calls = [];

  h.win.SpeechRecognition = {
    prototype: { processLocally: false },
    available: async (value) => {
      calls.push(value);

      return 'available';
    },
  };
  await languageControl(h.wrapper).setValue('en');
  await h.flushPromises();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(await h.module.probeLocalSpeech(h.win, 'auto'), 'available');
  assert.deepEqual(calls, [{ langs: ['ru'], processLocally: true }]);
});

test('I18N-S02/metadata: builtin подписи/confirm/search переводятся по ID без изменения DTO', async (t) => {
  const field = directSshSetting();
  const provider = {
    id: 'codex',
    name: 'GPT (Codex)',
    type: 'universal',
    available: true,
    installed: true,
    settings: [field],
    credentials: [],
    models: [],
  };
  const h = await i18nComponent(t, {
    responses: { '/api/providers': { providers: [provider] } },
  });
  const providers = h.module.useProvidersStore(h.pinia);

  providers.providers = [structuredClone(provider)];
  providers.loaded = true;
  h.settings.setAuthenticated(true);
  h.settings.requestOpen({ 
    pageId: 'agents.providers', 
    entityId: 'codex', 
     
  });
  h.settings.selectPage('agents.providers', 'codex', 'parameters');

  const wrapper = h.mount({
    render: () => h.h('div', [h.h(h.module.ProviderPage, { active: true }), h.h(h.module.UiDialogHost)]),
  }, { attachTo: document.body, global: { plugins: [h.pinia], stubs: { transition: false } } });

  t.after(() => wrapper.unmount());
  await h.flushPromises();

  const before = JSON.stringify(providers.providers);
  const translated = await catalogMessage('settings', field.label);

  await h.module.localeAdapter.setUiLanguage('en');
  await h.flushPromises();

  const toggle = wrapper.find(`[aria-label="${translated.en}"]`);

  assert.equal(toggle.exists(), true);
  assert.equal(h.settings.dynamicFields.some((entry) => entry.label === translated.en), true);
  assert.equal(JSON.stringify(providers.providers), before);
  await toggle.setValue(false);
  await h.flushPromises();
  assert.equal(Boolean(document.querySelector('[role="dialog"]')), true);
  assert.doesNotMatch(document.querySelector('[role="dialog"]').textContent, /[А-Яа-яЁё]/);

  const cancel = [...document.querySelectorAll('[role="dialog"] button')]
    .find((button) => button.textContent.trim() === 'Cancel');

  assert.equal(Boolean(cancel), true);
  cancel.click();
  await h.flushPromises();
  assert.equal(JSON.stringify(providers.providers), before);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
});
