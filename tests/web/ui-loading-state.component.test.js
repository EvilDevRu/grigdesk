import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

let mount;
let flushPromises;
let nextTick;
let locale;
let LoadingState;
let asyncView;

before(async () => {
  await installUiBrowser({ after });
  ({ mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  ));
  ({ nextTick } = await import('../../web/node_modules/vue/index.mjs'));
  locale = await import('../../web/src/services/locale.ts');
  globalThis.__loadingLocale = locale;

  const stubs = {
    '../../services/locale.ts': `export const {
      t, resolveUiText, messageRef, uiLocale, setUiLocale, snapshotText, locales,
    } = globalThis.__loadingLocale;`,
  };

  LoadingState = await compileVue(webFile('src/components/feedback/UiLoadingState.vue'), { stubs });
  ({ asyncView } = await compileModule(webFile('src/shared/asyncView.ts'), { stubs }));
});

after(() => {
  locale?.setUiLocale('ru');
  delete globalThis.__loadingLocale;
});

test('загрузка объявляет один статус, силуэты скрыты от чтения и не изображают прогресс', async (t) => {
  const wrapper = mount(LoadingState);

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.findAll('[role="status"]').length, 1);
  assert.equal(wrapper.find('[role="progressbar"]').exists(), false);
  assert.equal(wrapper.find('.ui-loading-state__skeleton').attributes('aria-hidden'), 'true');
  assert.equal(wrapper.findAll('.ui-loading-state__item').length, 4);
  assert.equal(wrapper.find('.ui-spinner').attributes('aria-hidden'), 'true');

  for (const variant of ['cards', 'document', 'inline']) {
    await wrapper.setProps({ variant });
    assert.equal(wrapper.attributes('data-variant'), variant);
    assert.equal(wrapper.find('.ui-loading-state__skeleton').exists(), variant !== 'inline');
  }
});

test('общая подпись меняет язык, собственный текст остаётся данными и не исполняется', async (t) => {
  locale.setUiLocale('ru');

  const wrapper = mount(LoadingState);

  t.after(() => {
    wrapper.unmount();
    locale.setUiLocale('ru');
  });
  assert.equal(wrapper.text(), locale.t('core.loading'));
  locale.setUiLocale('en');
  await nextTick();
  assert.equal(wrapper.text(), locale.t('core.loading'));
  await wrapper.setProps({ label: '<b>core.loading</b>', description: 'Данные Я🦊' });
  assert.equal(wrapper.find('b').exists(), false);
  assert.ok(wrapper.text().includes('<b>core.loading</b>'));
  assert.ok(wrapper.text().includes('Данные Я🦊'));
});

test('ленивая панель показывает общую загрузку до готовности и снимает её после успеха', async (t) => {
  const result = Promise.withResolvers();
  const Pending = asyncView(() => result.promise);
  const wrapper = mount({ components: { Pending }, template: '<div><Pending /></div>' });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.find('[data-ui-loading]').exists(), true);
  result.resolve({ template: '<section data-loaded>Панель готова</section>' });
  await flushPromises();
  await setImmediate();
  await nextTick();
  assert.equal(wrapper.find('[data-ui-loading]').exists(), false);
  assert.equal(wrapper.find('[data-loaded]').exists(), true);
});

test('ленивая панель сохраняет специальный каркас и показывает ошибку после отказа', async (t) => {
  const result = Promise.withResolvers();
  const failures = [];
  const Pending = asyncView(
    () => result.promise,
    { template: '<div data-special-loading>Каркас кода</div>' },
    (error) => failures.push(error.message),
  );
  const wrapper = mount({ components: { Pending }, template: '<div><Pending /></div>' }, {
    global: { config: { warnHandler() {}, errorHandler() {} } },
  });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.find('[data-special-loading]').exists(), true);
  assert.equal(wrapper.find('[data-ui-loading]').exists(), false);
  result.reject(new Error('Синтетический отказ чанка'));
  await flushPromises();
  await setImmediate();
  await nextTick();
  assert.equal(wrapper.find('[data-special-loading]').exists(), false);
  assert.equal(wrapper.find('[role="alert"]').exists(), true);
  assert.deepEqual(failures, ['Синтетический отказ чанка']);
});
