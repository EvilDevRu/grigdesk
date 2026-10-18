import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const COMPONENT_PATH = webFile('src/views/board/TaskFavoriteButton.vue');

let component;
async function loadComponent() {
  component ||= await compileVue(COMPONENT_PATH);

  return component;
}

async function browserFixture(t) {
  return installUiBrowser(t, 'http://grigdesk.test/#/board');
}

test('UI-01/02: кнопка отражает состояние, подписана и эмитит toggle', async (t) => {
  const browser = await browserFixture(t);
  const [{ mount }, TaskFavoriteButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    loadComponent(),
  ]);
  const wrapper = mount(TaskFavoriteButton, {
    attachTo: browser.document.querySelector('#mount'),
    props: { active: false, taskTitle: 'Исправить форму' },
  });
  t.after(() => wrapper.unmount());

  const button = wrapper.get('button');
  assert.equal(button.attributes('aria-pressed'), 'false');
  assert.equal(button.attributes('aria-label'), 'Добавить задачу «Исправить форму» в избранное');
  assert.equal(button.get('svg').attributes('fill'), 'none');

  await button.trigger('click');
  assert.equal(wrapper.emitted('toggle').length, 1);

  await wrapper.setProps({ active: true });
  assert.equal(button.attributes('aria-pressed'), 'true');
  assert.equal(button.attributes('aria-label'), 'Убрать задачу «Исправить форму» из избранного');
  assert.equal(button.get('svg').attributes('fill'), 'currentColor');
  assert.equal(button.classes().includes('active'), false);
  assert.equal(button.classes().includes('is-pressed'), true);
});

test('UI-03: pending блокирует кнопку и сообщает занятость', async (t) => {
  const browser = await browserFixture(t);
  const [{ mount }, TaskFavoriteButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    loadComponent(),
  ]);
  const wrapper = mount(TaskFavoriteButton, {
    attachTo: browser.document.querySelector('#mount'),
    props: { active: true, pending: true, taskTitle: 'Задача 42' },
  });
  t.after(() => wrapper.unmount());

  const button = wrapper.get('button');
  assert.equal(button.attributes('disabled'), undefined);
  assert.equal(button.attributes('aria-disabled'), 'true');
  assert.equal(button.attributes('aria-busy'), 'true');
  assert.equal(button.get('svg').attributes('width'), '18');
  assert.equal(button.get('svg').attributes('height'), '18');
  assert.ok(button.get('path').attributes('d'), 'звезда остаётся в DOM во время сохранения');
  await button.trigger('click');
  assert.equal(wrapper.emitted('toggle'), undefined);
});

test('UI-04: ожидание ответа не прячет звезду пульсацией', async () => {
  const source = await readFile(COMPONENT_PATH, 'utf8');
  assert.doesNotMatch(source, /fav-pulse|opacity:\s*\.35/);
});

test('UI-05: компонент не использует синюю обводку фокуса', async () => {
  const source = await readFile(COMPONENT_PATH, 'utf8');
  assert.doesNotMatch(source, /box-shadow:[^;]*var\(--accent\)/);
});
