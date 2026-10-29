import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../../web/src/shared/apiClient.ts';
import { descriptor, pluginCard } from './helpers/pluginModuleContract.js';
import { deferred, importer, runtimeFixture, settle } from './helpers/pluginRuntimeUnit.js';

const withoutResources = {

   ...descriptor,

  css: [],

  locales: {}

};

test('PM-LOAD: default-компонент загружается только после общей Vue/UI identity', async (t) => {
  const runtime = await runtimeFixture(t);
  const component = { render: () => null };
  const imports = importer(runtime, component);
  const result = await runtime.loadPluginModule('ui-module', withoutResources, {
    signal: new AbortController().signal,
    importModule: imports.importModule,
  });

  assert.equal(result.component, component);
  assert.ok(imports.calls.indexOf('vue') < imports.calls.indexOf(descriptor.entry));
  assert.ok(imports.calls.indexOf('@grigdesk/ui') < imports.calls.indexOf(descriptor.entry));
  assert.equal(typeof result.releaseStyles, 'function');
  result.releaseStyles();
});

for (const variant of ['missing-map', 'wrong-vue', 'wrong-ui']) {
  test(`PM-LOAD: ${variant} даёт unsupported до исполнения entry`, async (t) => {
    const runtime = await runtimeFixture(t);
    const overrides = variant === 'missing-map'
      ? { vue: async () => {
         throw new TypeError('bare specifier');
      } }
      : variant === 'wrong-vue'
        ? { vue: async () => ({ ...runtime.vue, ref: () => ({ value: null }) }) }
        : { '@grigdesk/ui': async () => ({ ...runtime.ui, UiButton: {} }) };
    const imports = importer(runtime, undefined, overrides);

    await assert.rejects(runtime.loadPluginModule('ui-module', withoutResources, {
      signal: new AbortController().signal,
      importModule: imports.importModule,
    }), (error) => error.code === 'unsupported');
    assert.equal(imports.calls.includes(descriptor.entry), false);
  });
}

for (const variant of ['import-reject', 'invalid-default', 'css-error']) {
  test(`PM-LOAD: ${variant} даёт load-failed и освобождает собственные стили`, async (t) => {
    const runtime = await runtimeFixture(t);
    const imports = importer(runtime, variant === 'invalid-default' ? {} : { render: () => null },
      variant === 'import-reject' ? {
      [descriptor.entry]: async () => {
         throw new TypeError('import 404');
      },
    } : {});
    const pending = runtime.loadPluginModule('ui-module', {
      ...withoutResources,
      css: variant === 'css-error' ? descriptor.css : [],
    }, {
      signal: new AbortController().signal,
      importModule: imports.importModule,
    });
    const rejection = assert.rejects(pending, (error) => error.code === 'load-failed');

    if (variant === 'css-error') {
      await settle();

      const link = document.querySelector('link[rel="stylesheet"]');

      assert.ok(link, 'Попытка должна действительно загрузить объявленный CSS');
      link.dispatchEvent(new runtime.browser.Event('error'));
    }

    await rejection;
    assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
  });
}

test('PM-LOAD: поздний import после abort не публикуется и чужой link сохраняется', async (t) => {
  const runtime = await runtimeFixture(t);
  const late = deferred();
  const abort = new AbortController();
  const foreign = document.createElement('link');

  foreign.rel = 'stylesheet';
  foreign.href = '/foreign.css';
  document.head.append(foreign);

  const imports = importer(runtime, undefined, { [descriptor.entry]: () => late.promise });
  const pending = runtime.loadPluginModule('ui-module', withoutResources, {
    signal: abort.signal,
    importModule: imports.importModule,
  });
  const rejected = assert.rejects(pending);

  await settle();
  abort.abort();
  late.resolve({ default: { render: () => null } });
  await rejected;
  assert.equal(foreign.isConnected, true);
});

test('PM-LOAD: отмена/CSS cleanup снимают только links своей попытки', async (t) => {
  const runtime = await runtimeFixture(t, ['styles']);
  const first = new AbortController();
  const second = new AbortController();
  const one = runtime.loadPluginStyles(descriptor.css, first.signal);
  const two = runtime.loadPluginStyles(descriptor.css, second.signal);
  const rejected = assert.rejects(one);

  await settle();

  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];

  assert.equal(links.length, 2);
  first.abort();
  await rejected;
  assert.equal(links[0].isConnected, false);
  assert.equal(links[1].isConnected, true);
  links[1].dispatchEvent(new runtime.browser.Event('load'));

  const cleanup = await two;

  cleanup();
  cleanup();
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
});

test('PM-LOAD-TIMEOUT: loading ограничен 30 секундами, поздний resolve игнорируется', async (t) => {
  const runtime = await runtimeFixture(t);
  const late = deferred();
  const imports = importer(runtime, undefined, { [descriptor.entry]: () => late.promise });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(runtime.browser, 'setTimeout', (...args) => globalThis.setTimeout(...args));
  t.mock.method(runtime.browser, 'clearTimeout', (timer) => globalThis.clearTimeout(timer));

  const pending = runtime.loadPluginModule('ui-module', withoutResources, {
    signal: new AbortController().signal,
    importModule: imports.importModule,
  });
  const rejected = assert.rejects(pending, (error) => error.code === 'load-failed');

  await settle();
  t.mock.timers.tick(30001);
  await rejected;
  late.resolve({ default: { render: () => null } });
  await settle();
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
});

test('PM-LOAD: чужие URL отклонены до import и CSS', async (t) => {
  const runtime = await runtimeFixture(t);
  const imports = importer(runtime);

  for (const entry of [
    'https://other.invalid/panel.js', '//other.invalid/a.js', '/api/ext/other/module/a.js',
  ]) {
    await assert.rejects(runtime.loadPluginModule('ui-module', { ...withoutResources, entry }, {
      signal: new AbortController().signal,
      importModule: imports.importModule,
    }));
  }

  assert.deepEqual(imports.calls, []);
});

test('PM-CONTEXT: API с сессией/401, ru/en, readonly live locale и values', async (t) => {
  const runtime = await runtimeFixture(t, ['context']);
  const store = runtime.vue.reactive({ card: pluginCard() });
  const plugins = { byId: () => store.card };
  const calls = [];
  const dictionaries = {
    [descriptor.locales.ru]: { greeting: 'Привет, {name}', onlyRussian: 'Запасной' },
    [descriptor.locales.en]: { greeting: 'Hello, {name}' },
  };

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });

    return new Response(JSON.stringify(dictionaries[url] ?? { ok: true }), {
      status: url === '/api/unauthorized' ? 401 : 200,
    });
  });

  const abort = new AbortController();
  const context = await runtime.createPluginContext('ui-module', descriptor, plugins, {
    signal: abort.signal,
  });

  assert.equal(context.pluginId, 'ui-module');
  assert.equal(context.t('greeting', { name: 'Тест' }), 'Привет, Тест');
  runtime.ui.setUiLocale('en');
  assert.equal(context.locale.value, 'en');
  assert.equal(context.t('greeting', { name: 'Test' }), 'Hello, Test');
  assert.equal(context.t('onlyRussian'), 'Запасной');
  assert.equal(context.t('missing'), 'missing');
  assert.equal(context.t('missing', {}, 'Явно'), 'Явно');

  const initial = context.settings.value;

  store.card = { ...store.card, values: { greeting: 'Другое', nested: { flag: true } } };
  assert.equal(context.settings.value.greeting, 'Другое');
  assert.equal(initial.greeting, 'Настройка');
  assert.equal(runtime.vue.isReadonly(context.settings), true);
  assert.equal(runtime.vue.isReadonly(context.settings.value), true);
  assert.equal(runtime.vue.isReadonly(context.locale), true);
  context.settings.value.greeting = 'Запрещено';
  context.settings.value.nested.flag = false;
  context.locale.value = 'ru';
  assert.equal(store.card.values.greeting, 'Другое');
  assert.equal(store.card.values.nested.flag, true);
  assert.equal(context.locale.value, 'en');

  for (const method of ['get', 'post', 'put', 'patch', 'del']) {
    await context.api[method]('/api/fixture/echo', { text: 'Данные' });
  }

  assert.deepEqual(calls.slice(-5).map((call) => call.options.method), [
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
  ]);
  await context.api.get('/api/ext/ui-module/echo');

  let unauthorized = 0;
  const unsubscribe = api.onUnauthorized(() => {
     unauthorized += 1;
  });

  t.after(unsubscribe);
  await assert.rejects(context.api.get('/api/unauthorized'));
  assert.equal(unauthorized, 1);

  const before = calls.length;

  for (const url of ['https://other.invalid/api/x', '//other.invalid/api/x', '/outside']) {
    await assert.rejects(async () => context.api.get(url));
  }

  assert.equal(calls.length, before);
  assert.ok(calls.every((call) => call.options.credentials === 'include'));

  const resourceCalls = calls.filter((call) => call.url in dictionaries);

  assert.equal(resourceCalls.length, 2);
  assert.ok(resourceCalls.every((call) => call.options.signal?.aborted === false));

  const reason = new Error('Панель закрыта');

  abort.abort(reason);
  assert.ok(resourceCalls.every((call) => call.options.signal.aborted));
  assert.ok(resourceCalls.every((call) => call.options.signal.reason === reason));
  runtime.ui.setUiLocale('ru');
});

for (const variant of ['invalid-json', '404', 'invalid-dictionary']) {
  test(`PM-CONTEXT: ${variant} ресурса не заменяет словари ядра`, async (t) => {
    const runtime = await runtimeFixture(t, ['context']);
    const original = runtime.ui.t('core.plugin');

    t.mock.method(globalThis, 'fetch', async () => new Response(
      variant === 'invalid-json' ? '{' : variant === 'invalid-dictionary' ? '[42]' : '{}',
      { status: variant === '404' ? 404 : 200 },
    ));
    await assert.rejects(runtime.createPluginContext('ui-module', descriptor, {
      byId: () => pluginCard(),
    }, { signal: new AbortController().signal }));
    assert.equal(runtime.ui.t('core.plugin'), original);
  });
}

test('PM-CONTEXT: пустые словари возвращают ключ', async (t) => {
  const runtime = await runtimeFixture(t, ['context']);
  const context = await runtime.createPluginContext('ui-module', withoutResources, {
    byId: () => pluginCard(),
  }, { signal: new AbortController().signal });

  assert.equal(context.t('unknown'), 'unknown');
});

test('PM-LEGACY-NAMED-START: загрузка без opt-in сохраняет default и не выполняет start', async (t) => {
  const runtime = await runtimeFixture(t);
  const component = { render: () => null };
  let starts = 0;
  const imports = importer(runtime, component, {
    [descriptor.entry]: async () => ({ default: component, start: () => starts += 1 }),
  });
  const result = await runtime.loadPluginModule('ui-module', withoutResources, {
    signal: new AbortController().signal,
    importModule: imports.importModule,
  });

  assert.equal(result.component, component);
  assert.equal(starts, 0);
  result.releaseStyles();
});

test('PM-BACKGROUND-LOAD: styles=false сохраняет default/start без links и исполнения hook', async (t) => {
  const runtime = await runtimeFixture(t);
  const controller = new AbortController();
  const component = { render: () => null };
  let starts = 0;
  const start = () => starts += 1;
  const imports = importer(runtime, component, {
    [descriptor.entry]: async () => ({ default: component, start }),
  });
  const pending = runtime.loadPluginModule('ui-module', descriptor, {
    signal: controller.signal,
    styles: false,
    importModule: imports.importModule,
  });

  pending.catch(() => {});
  t.after(() => controller.abort());
  await settle();
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0,
    'Фоновая загрузка не должна подключать CSS панели');

  const result = await pending;

  assert.equal(result.component, component);
  assert.equal(result.start, start);
  assert.equal(starts, 0);
  result.releaseStyles();
});

test('PM-BACKGROUND-LOAD: поздний import после abort не выполняет named start', async (t) => {
  const runtime = await runtimeFixture(t);
  const late = deferred();
  const abort = new AbortController();
  let starts = 0;
  const imports = importer(runtime, undefined, { [descriptor.entry]: () => late.promise });
  const pending = runtime.loadPluginModule('ui-module', withoutResources, {
    signal: abort.signal,
    styles: false,
    importModule: imports.importModule,
  });
  const rejected = assert.rejects(pending);

  await settle();
  abort.abort();
  late.resolve({ default: { render: () => null }, start: () => starts += 1 });
  await rejected;
  assert.equal(starts, 0);
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
});
