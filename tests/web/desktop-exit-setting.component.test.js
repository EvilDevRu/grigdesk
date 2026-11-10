import assert from 'node:assert/strict';
import test from 'node:test';

import { i18nComponent } from './helpers/i18nComponent.js';
import { settingsResource } from './helpers/settings-session.js';
import { catalogMessage } from './helpers/i18nCatalog.js';

const label = 'Спрашивать перед выходом при активной работе';
const mainAgent = 'Synthetic GrigDeskSettings/1 GrigDeskWindow/main';

/**
 * Реальная InterfacePage получает настоящий shell store с optional desktop capability.
 * Только HTTP-сохранение подменено; settings dirty и locale остаются продуктовыми.
 */
async function interfacePage(t, options = {}) {
  let shell;
  let saved;
  let revision = 3;
  const snapshot = {
    rev: revision,
    profile: null,
    profiles: [],
    status: 'none',
    detail: null,
    capabilities: [],
    localAvailable: false,
    desktopExit: { skipConfirmation: options.skipConfirmation ?? true },
  };
  const h = await i18nComponent(t, {
    prepareWindow(win) {
      Object.defineProperty(win.navigator, 'userAgent', {
        value: options.userAgent ?? mainAgent,
        configurable: true,
      });
    },
    bootstrap(module, pinia) {
      shell = module.useShellStore(pinia);
      shell.apply(options.withoutCapability ? { ...snapshot, desktopExit: undefined } : snapshot);

      return { shell };
    },
    /**
     * Настройка сохраняется только локальной shell-командой, без серверного Apply.
     * Ответ отражает принятое значение и новую ревизию того же snapshot.
     */
    fetch(url, init = {}) {
      assert.equal(String(url), '/__shell/exit-preference');
      assert.equal(init.method, 'POST');

      const body = JSON.parse(init.body);

      saved = body;

      return options.respond ? options.respond(body) : new Response(JSON.stringify({
        ...snapshot,
        rev: ++revision,
        desktopExit: body,
      }));
    },
  });

  h.module.setUiLocale(options.locale ?? 'ru');
  h.settings.setAuthenticated(true);
  h.settings.requestOpen({ pageId: 'interface.behavior' });

  const wrapper = h.mount(h.module.InterfacePage, {
    attachTo: h.win.document.body,
    props: { active: true },
    global: { plugins: [h.pinia] },
  });

  t.after(() => wrapper.unmount());
  await h.flushPromises();

  return {
    ...h,
    wrapper,
    shell,
    snapshot,
    saved: () => saved,
  };
}

/**
 * Соседний wakeLock тоже является switch и остаётся на странице.
 * Контрол выхода различается по доступной подписи, а не по порядку среди настроек.
 */
function exitControls(h) {
  return h.wrapper.findAll('[role="switch"]').filter((item) =>
    /выход|exit|quit/i.test(item.attributes('aria-label') ?? ''));
}

/**
 * Доступная подпись берётся из того же desktop.json, что и переводчик продукта.
 * Отсутствие switch проверяется до чтения пока не добавленного ключа каталога.
 */
async function control(h, locale = 'ru') {
  const switches = exitControls(h);

  assert.equal(switches.length, 1, 'К8: InterfacePage показывает desktop-only переключатель выхода');

  const text = (await catalogMessage('desktop', label))[locale];
  const item = switches[0];
  const labelText = item.attributes('aria-label') ?? h.wrapper.text();

  assert.ok(labelText.includes(text));

  return item;
}

for (const locale of ['ru', 'en']) {
  test(`SET01: ${locale}, сохранённый выбор, немедленное true→false→true без dirty и Apply`, async (t) => {
    const h = await interfacePage(t, { locale });
    const resource = settingsResource('exit-neighbour', { value: 'до' });

    h.settings.registerResource(resource.adapter, resource.fields);
    await h.settings.loadResource('exit-neighbour');
    h.settings.setField('exit-neighbour', 'value', 'несохранённое');

    const dirty = h.settings.snapshot.dirtyCount;
    let item = await control(h, locale);

    assert.equal(item.attributes('aria-checked'), 'false');
    await item.setValue(!item.element.checked);
    await h.flushPromises();
    assert.deepEqual(h.saved(), { skipConfirmation: false });
    item = await control(h, locale);
    assert.equal(item.attributes('aria-checked'), 'true');
    await item.setValue(!item.element.checked);
    await h.flushPromises();
    assert.deepEqual(h.saved(), { skipConfirmation: true });
    assert.equal(h.settings.snapshot.dirtyCount, dirty);
    assert.equal(h.settings.getValue('exit-neighbour', 'value'), 'несохранённое');
    assert.equal(resource.calls.writes.length, 0);
    h.settings.cancel();
    await h.flushPromises();
    assert.equal(h.shell.snapshot.desktopExit.skipConfirmation, true);
    assert.equal(h.calls.some((call) => String(call.pathname).startsWith('/api/settings/prefs')), false);
    assert.equal(h.win.localStorage.getItem('skipExitConfirmation'), null);
  });
}

test('SET01/error: отказ save возвращает принятый выбор, старый poll не откатывает успешный', async (t) => {
  let pending = Promise.withResolvers();
  const h = await interfacePage(t, { respond: () => pending.promise });
  const item = await control(h);

  t.after(() => pending.resolve(new Response('{}')));
  await item.setValue(!item.element.checked);
  await h.nextTick();
  assert.ok(item.attributes('disabled') !== undefined
    || item.attributes('aria-disabled') === 'true');
  h.shell.apply({ ...h.snapshot, rev: 4 });
  await h.nextTick();
  assert.equal((await control(h)).attributes('aria-checked'), 'true',
    'Старый poll не отменяет ожидающее сохранение');
  pending.resolve(new Response('{"error":"save_failed","message":"Тестовый отказ сохранения"}', {
    status: 500,
  }));
  await h.flushPromises();
  assert.equal((await control(h)).attributes('aria-checked'), 'false');
  assert.match(h.wrapper.text(), /Тестовый отказ сохранения|Не удалось сохранить/);
  pending = Promise.withResolvers();
  await (await control(h)).setValue(true);
  await h.nextTick();
  h.shell.apply({ ...h.snapshot, rev: 5 });
  pending.resolve(new Response(JSON.stringify({
    ...h.snapshot,
    rev: 6,
    desktopExit: { skipConfirmation: false },
  })));
  await h.flushPromises();
  h.shell.apply({ ...h.snapshot, rev: 4 });
  await h.nextTick();
  assert.equal((await control(h)).attributes('aria-checked'), 'true');
  h.shell.apply({
    ...h.snapshot,
    rev: 7,
    desktopExit: { skipConfirmation: true },
  });
  await h.nextTick();
  assert.equal((await control(h)).attributes('aria-checked'), 'false',
    'Remember приходит через shell snapshot');
});

for (const options of [
  { userAgent: 'Synthetic Browser' },
  { userAgent: 'Synthetic GrigDeskAndroid/1' },
  { userAgent: 'Synthetic GrigDeskSettings/1 GrigDeskWindow/surface' },
  { withoutCapability: true },
]) {
  test(`SET02: без поддержки main desktop настройка скрыта ${JSON.stringify(options)}`, async (t) => {
    const h = await interfacePage(t, options);

    assert.equal(exitControls(h).length, 0);
    assert.equal(h.calls.length, 0);
  });
}
