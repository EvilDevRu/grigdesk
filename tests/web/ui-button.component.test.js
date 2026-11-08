import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

/*
 * Возвращает тело единственного CSS-правила по точному селектору.
 * Пустая строка значит, что правила нет, и проверка размера падает с понятной причиной.
 */
function cssRuleBody(source, selector) {
  const start = source.indexOf(`${selector} {`);

  if (start < 0) {
    return '';
  }

  return source.slice(start, source.indexOf('}', start));
}

test('UiButton безопасно задаёт type и блокирует loading/ariaDisabled', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiButton.vue')),
  ]);
  let clicks = 0;
  const wrapper = mount(UiButton, {
    attachTo: browser.document.querySelector('#mount'),
    props: { onClick: () => { clicks += 1; } },
    slots: { default: 'Запустить' },
  });
  assert.equal(wrapper.element.tagName, 'BUTTON');
  assert.equal(wrapper.attributes('type'), 'button');
  await wrapper.trigger('click');
  assert.equal(clicks, 1);

  await wrapper.setProps({ loading: true });
  assert.equal(wrapper.attributes('aria-busy'), 'true');
  assert.equal(wrapper.attributes('aria-disabled'), 'true');
  assert.match(wrapper.text(), /Запустить/);
  await wrapper.trigger('click');
  assert.equal(clicks, 1);

  await wrapper.setProps({ loading: false, ariaDisabled: true });
  assert.equal(wrapper.attributes('disabled'), undefined);
  await wrapper.trigger('click');
  assert.equal(clicks, 1);
  wrapper.unmount();
});

test('UiButton выбирает обычный или компактный размер параметром, а не местом', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiButton.vue')),
  ]);
  const wrapper = mount(UiButton, {
    attachTo: browser.document.querySelector('#mount'),
    slots: { default: 'Продолжить' },
  });

  assert.equal(wrapper.attributes('data-size'), 'default', 'без параметра кнопка обычная');

  await wrapper.setProps({ size: 'compact' });
  assert.equal(wrapper.attributes('data-size'), 'compact');

  await wrapper.setProps({ size: 'huge' });
  assert.equal(wrapper.attributes('data-size'), 'default', 'неизвестный размер не ломает вид');
  wrapper.unmount();

  const actions = fs.readFileSync(webFile('src/styles/components/actions.css'), 'utf8');
  const compact = cssRuleBody(actions, ".ui-button[data-size='compact']");

  assert.match(compact, /\bheight: var\(--toolbar-control-h\);/, 'компактная высота — общий токен 28/44 px');
  assert.match(compact, /min-height: var\(--toolbar-control-h\);/);
});

test('UiActionLink остаётся ссылкой и guard снимает переход', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiActionLink] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiActionLink.vue')),
  ]);
  const wrapper = mount(UiActionLink, {
    attachTo: browser.document.querySelector('#mount'),
    props: { href: '/settings', target: '_blank' },
    slots: { default: 'Настройки' },
  });
  assert.equal(wrapper.element.tagName, 'A');
  assert.equal(wrapper.attributes('href'), '/settings');
  assert.equal(wrapper.attributes('rel'), 'noopener noreferrer');
  await wrapper.setProps({ wrap: true });
  assert.equal(wrapper.classes().includes('ui-button--wrap'), true);
  assert.equal(wrapper.attributes('href'), '/settings');
  await wrapper.setProps({ disabled: true });
  assert.equal(wrapper.attributes('href'), undefined);
  assert.equal(wrapper.attributes('aria-disabled'), 'true');
  assert.equal(wrapper.attributes('tabindex'), '-1');
  wrapper.unmount();
});
