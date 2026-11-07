import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { mdToHtml, mdTokensToHtml } from '../../web/src/shared/md.ts';

test('Markdown обновляет реактивный href без смены текста и сохраняет санитаризацию', async (t) => {
  const browser = await installUiBrowser(t);
  const {
    ref
  } = await import('../../web/node_modules/vue/index.mjs');
  const target = ref('#/code?path=first');
  let renders = 0;

  globalThis.__markdownRenderer = (...args) => {
    renders += 1;

    return typeof args[0] === 'string' ? mdToHtml(...args) : mdTokensToHtml(...args);
  };
  globalThis.__markdownHref = () => target.value;

  const [component, {
    mount,
    flushPromises
  }] = await Promise.all([
    compileVue(webFile('src/views/chat/ChatMarkdown.vue'), {
      stubs: {
        '../../shared/md.ts': [
          "export * from './src/shared/md.ts';",
          'export const mdToHtml = (...args) => globalThis.__markdownRenderer(...args);',
        ].join('\n'),
        '../md.ts': [
          "export * from './src/shared/md.ts';",
          'export const mdTokensToHtml = (...args) => globalThis.__markdownRenderer(...args);',
        ].join('\n'),
        './codeHighlight.ts': 'export const highlightCode = async () => null;',
        './mermaidRender.ts': 'export const renderMermaid = async () => null;',
        '../clipboard.ts': 'export const writeClipboardText = async () => false;',
        '../../features/code/links.ts': 'export const chatFileLinkHref = (...args) => ' +
          'globalThis.__markdownHref(...args);',
      }
    }),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      text: '[Файл](/repo/file.ts)\n\n<script>alert(1)</script>\n\n![кадр](/repo/frame.png)',
      chatId: 'c1',
    }
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__markdownRenderer;
    delete globalThis.__markdownHref;
  });
  assert.equal(wrapper.get('a').attributes('href'), '#/code?path=first');
  assert.equal(wrapper.find('script').exists(), false);
  assert.equal(wrapper.get('img').attributes('src'), '/api/chat/c1/image?path=%2Frepo%2Fframe.png');
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
