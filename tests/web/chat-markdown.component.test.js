import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { mdToHtml } from '../../web/src/shared/md.ts';

test('Markdown обновляет реактивный href без смены текста и сохраняет санитаризацию', async (t) => {
  const browser = await installUiBrowser(t);
  const {
    ref
  } = await import('../../web/node_modules/vue/index.mjs');
  const target = ref('#/code?path=first');
  let renders = 0;

  globalThis.__markdownRenderer = (...args) => {
    renders += 1;

    return mdToHtml(...args);
  };
  globalThis.__markdownHref = () => target.value;

  const [component, {
    mount,
    flushPromises
  }] = await Promise.all([
    compileVue(webFile('src/views/chat/ChatMarkdown.vue'), {
      stubs: {
        '../../shared/md.ts': 'export const mdToHtml = (...args) => globalThis.__markdownRenderer(...args);',
        '../../features/code/links.ts': 'export const chatFileLinkHref = (...args) => ' +
          'globalThis.__markdownHref(...args);',
      }
    }),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      text: '[Файл](/repo/file.ts)\n\n<script>alert(1)</script>'
    }
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__markdownRenderer;
    delete globalThis.__markdownHref;
  });
  assert.equal(wrapper.get('a').attributes('href'), '#/code?path=first');
  assert.equal(wrapper.find('script').exists(), false);
  assert.equal(renders, 1);
  await wrapper.setProps({
    title: 'Изменённый статус'
  });
  assert.equal(renders, 1);
  target.value = '#/code?path=second';
  await flushPromises();
  assert.equal(wrapper.get('a').attributes('href'), '#/code?path=second');
  assert.equal(renders, 2);
});
