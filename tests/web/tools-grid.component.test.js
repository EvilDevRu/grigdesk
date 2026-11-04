process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

import { NAV_ICONS } from '../../web/src/shared/navIcons.ts';

let browser;
let ToolsGrid;
let UiDialog;
let h;
let nextTick;
let mount;
let flushPromises;
let createRouter;
let createMemoryHistory;

before(async () => {
  browser = await createUiBrowser();
  Object.defineProperty(globalThis, 'history', {
    value: browser.history,
    configurable: true,
  });

  const [utils, router, component, dialog, vue] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue-router/dist/vue-router.mjs'),
    compileVue(webFile('src/shared/layout/ToolsGrid.vue')),
    compileVue(webFile('src/components/overlays/UiDialog.vue')),
    import('../../web/node_modules/vue/index.mjs'),
  ]);

  ({ mount, flushPromises } = utils);
  ({ createRouter, createMemoryHistory } = router);
  ToolsGrid = component;
  UiDialog = dialog;
  ({ h, nextTick } = vue);
});

test('PH-NAV: диалог фокусирует список и сбрасывает поиск при повторном открытии', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });

  await router.push('/board');
  await router.isReady();

  const wrapper = mount(UiDialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      open: true,
      label: 'Разделы',
      size: 'workspace',
      'data-role': 'phone-sections',
      initialFocus: '.tools-grid',
    },
    slots: {
      header: () => h('h2', { class: 'ui-dialog__title' }, 'Разделы'),
      default: () => h(ToolsGrid, {
        items: [{
          to: '/board',
          label: 'Доска',
          icon: 'board',
        }],
        layout: 'list',
        searchable: true,
      }),
    },
    global: {
      plugins: [router],
      stubs: { transition: false },
    },
  });

  t.after(() => wrapper.unmount());
  await nextTick();
  await flushPromises();

  let grid = wrapper.findComponent(ToolsGrid);

  assert.equal(browser.document.activeElement === grid.get('nav').element, true);

  const cssText = (await Promise.all(['tokens', 'components/overlays'].map((file) =>
    readFile(webFile(`src/styles/${file}.css`), 'utf8')))).join('\n');
  const style = browser.document.createElement('style');

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());

  const dialog = browser.document.querySelector('[data-role="phone-sections"]');
  const overlay = dialog.closest('.ui-dialog-overlay');
  const css = browser.getComputedStyle(dialog);

  assert.equal(dialog.getAttribute('aria-label'), 'Разделы');
  assert.equal(overlay.hasAttribute('data-mobile-sheet'), false);
  assert.equal(css.width, '100%');
  assert.equal(css.height, '100%');
  assert.equal(css.borderRadius, '0px');
  assert.equal(browser.getComputedStyle(overlay).padding, '0px');

  await grid.get('input[type="search"]').setValue('нет');
  assert.equal(grid.findAll('a').length, 0);

  await wrapper.setProps({ open: false });
  await flushPromises();
  await wrapper.setProps({ open: true });
  await flushPromises();

  grid = wrapper.findComponent(ToolsGrid);
  assert.equal(grid.get('input[type="search"]').element.value, '');
  assert.equal(grid.findAll('a').length, 1);
  assert.equal(browser.document.activeElement === grid.get('nav').element, true);
});

after(async () => browser.close());

test('PH-NAV: поиск, пустота, очистка, динамический плагин и переход', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });

  await router.push('/board');
  await router.isReady();

  const items = [
    {
      to: '/board',
      label: 'Доска',
      icon: 'board',
    },
    {
      to: '/plugin/example',
      label: 'Тестовый плагин',
      icon: 'plugin',
    },
  ];
  const wrapper = mount(ToolsGrid, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      items,
      layout: 'list',
      searchable: true,
    },
    global: { plugins: [router] },
  });

  t.after(() => wrapper.unmount());

  assert.equal(wrapper.findAll('a').length, 2);
  assert.equal(wrapper.get('a[href="/board"]').attributes('aria-current'), 'page');
  assert.equal(wrapper.find('input[type="search"]').exists(), true);

  const style = browser.document.createElement('style');
  const cssText = await readFile(webFile('src/styles/components/actions.css'), 'utf8');

  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());
  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  style.textContent = cssText;
  assert.equal(browser.getComputedStyle(wrapper.get('a').element).fontSize, '15px');
  browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  style.textContent = cssText;
  assert.equal(browser.getComputedStyle(wrapper.get('a').element).fontSize, '13px');
  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  style.textContent = cssText;

  const search = wrapper.get('input[type="search"]');

  assert.equal(browser.document.activeElement === search.element, false);
  await search.setValue('ПЛАГИН');
  assert.deepEqual(wrapper.findAll('a').map((link) => link.attributes('href')), ['/plugin/example']);
  await search.setValue('нет такого раздела');
  assert.equal(wrapper.findAll('a').length, 0);
  assert.ok(wrapper.get('[role="status"]').text().length > 0);
  await search.setValue('');
  assert.equal(wrapper.findAll('a').length, 2);

  await wrapper.setProps({
    items: [...items, {
      to: '/plugin/new',
      label: 'Новый',
      icon: 'plugin',
    }],
    badges: {
      '/plugin/new': {
        n: 3,
        title: 'Три события',
        kind: 'wait',
      },
    },
  });

  const link = wrapper.get('a[href="/plugin/new"]');

  assert.match(link.attributes('aria-label'), /Три события/u);
  assert.equal(link.get('.navigation-count-text').text(), '3');
  await link.trigger('click');
  await flushPromises();
  assert.equal(router.currentRoute.value.path, '/plugin/new');
  assert.equal(wrapper.emitted('select').length, 1);

  await wrapper.setProps({ searchable: false });
  assert.equal(wrapper.find('input[type="search"]').exists(), false);
  assert.equal(wrapper.findAll('a').length, 3);
});


test('PH-NAV: группы сохраняют порядок, скрывают пустые и обновляют плагины при поиске', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });

  await router.push('/board');
  await router.isReady();

  const items = [
    {
      to: '/code',
      label: 'Код',
      icon: 'code',
      section: 'dev',
    },
    {
      to: '/board',
      label: 'Доска',
      icon: 'board',
      section: 'work',
    },
    {
      to: '/terminal',
      label: 'Терминал',
      icon: 'terminal',
      section: 'dev',
    },
  ];
  const wrapper = mount(ToolsGrid, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      items,
      layout: 'list',
      searchable: true,
      groups: [
        { id: 'work', label: 'Задачи и связь' },
        { id: 'dev', label: 'Разработка' },
        { id: 'other', label: 'Прочее' },
      ],
    },
    global: { plugins: [router] },
  });

  t.after(() => wrapper.unmount());

  const groupLabels = () => wrapper.findAll('h2').map((heading) => heading.text());
  const destinations = () => wrapper.findAll('a').map((link) => link.attributes('href'));
  const search = wrapper.get('input[type="search"]');

  assert.deepEqual(groupLabels(), ['Задачи и связь', 'Разработка']);
  assert.deepEqual(destinations(), ['/board', '/code', '/terminal']);
  await search.setValue('КОД');
  assert.deepEqual(groupLabels(), ['Разработка']);
  assert.deepEqual(destinations(), ['/code']);
  await search.setValue('нет');
  assert.deepEqual(groupLabels(), []);
  assert.equal(wrapper.find('[role="status"]').exists(), true);
  await search.setValue('');

  await wrapper.setProps({
    items: [...items, {
      to: '/ext/new',
      label: 'Новый плагин',
      icon: 'plugin',
      section: 'other',
    }],
    badges: {
      '/ext/new': {
        n: 2,
        title: 'Два события',
        kind: 'wait',
      },
    },
  });

  assert.deepEqual(groupLabels(), ['Задачи и связь', 'Разработка', 'Прочее']);

  const link = wrapper.get('section[aria-label="Прочее"] a');

  assert.equal(link.get('.navigation-count-text').text(), '2');
  await link.trigger('click');
  await flushPromises();
  assert.equal(router.currentRoute.value.path, '/ext/new');
  assert.equal(wrapper.emitted('select').length, 1);
});


test('файловая иконка плагина обновляется вместе с каталогом и имеет fallback', async (t) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  const item = {
    id: 'audit',
    to: '/ext/audit',
    label: 'Аудит',
    icon: `/api/plugins/audit/icon/${'a'.repeat(64)}`,
  };

  await router.push('/ext/audit');
  await router.isReady();

  const wrapper = mount(ToolsGrid, {
    props: { items: [item] },
    global: { plugins: [router] },
  });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.get('img').attributes('src'), item.icon);
  await wrapper.get('img').trigger('error');
  assert.equal(wrapper.get('svg path').attributes('d'), NAV_ICONS.plugin);
  assert.equal(wrapper.find('script').exists(), false);

  const nextIcon = `/api/plugins/audit/icon/${'b'.repeat(64)}`;

  await wrapper.setProps({ items: [{ ...item, icon: nextIcon }] });
  assert.equal(wrapper.get('img').attributes('src'), nextIcon);
});
