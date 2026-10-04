// Компонентные проверки используют настоящие Vue/UI и явные порты тяжёлых операций.
import { compileVue, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';

export const MARKDOWN_STUBS = {
  './codeHighlight.ts': 'export const highlightCode = (...args) => globalThis.__mdHighlight(...args);',
  './mermaidRender.ts': 'export const renderMermaid = (...args) => globalThis.__mdMermaid(...args);',
  '../clipboard.ts': 'export const writeClipboardText = (...args) => globalThis.__mdClipboard(...args);',
};

/**
 * Каждый mount получает собственные счётчики и отложенные ответы загрузчиков.
 * Тест задаёт только результат порта, а жизненный цикл выполняет production компонент.
 */
export async function mountMarkdown(t, file, props, options = {}) {
  const browser = await installUiBrowser(t);
  const calls = {
    highlight: [],
    mermaid: [],
    clipboard: [],
  };
  const defaults = {
    highlight: async () => null,
    mermaid: async () => ({
      src: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E',
      width: 120,
      height: 80,
    }),
    clipboard: async () => true,
  };

  const ports = [['highlight', 'Highlight'], ['mermaid', 'Mermaid'], ['clipboard', 'Clipboard']];

  for (const [name, suffix] of ports) {
    globalThis[`__md${suffix}`] = (...args) => {
      calls[name].push(args);

      return (options[name] || defaults[name])(...args);
    };
  }

  const [component, { mount, flushPromises }] = await Promise.all([
    compileVue(webFile(file), { stubs: { ...MARKDOWN_STUBS, ...options.stubs } }),
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props,
    slots: options.slots || {},
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__mdHighlight;
    delete globalThis.__mdMermaid;
    delete globalThis.__mdClipboard;
  });

  return {
    wrapper,
    calls,
    flushPromises,
    browser,
  };
}
