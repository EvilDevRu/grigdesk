import assert from 'node:assert/strict';
import test from 'node:test';

import { mountMarkdown } from './helpers/rich-markdown.js';

const FILE = 'src/shared/markdown/FenceMermaid.vue';
const CODE = 'flowchart TD\n A-->B';

test('RMD-DIAG-01: открытая схема — код, отрисовки нет', async (t) => {
  const { wrapper, calls } = await mountMarkdown(t, FILE, { code: CODE, closed: false });

  assert.equal(calls.mermaid.length, 0);
  assert.equal(wrapper.find('.md-fence[data-lang="mermaid"]').exists(), true);
  assert.equal(wrapper.find('img').exists(), false);
});

test('RMD-DIAG-02: закрытая схема — картинка с размером и подписью', async (t) => {
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, { code: CODE, closed: true });

  await flushPromises();
  assert.equal(calls.mermaid.length, 1);
  assert.equal(calls.mermaid[0][0], CODE);
  assert.equal(wrapper.find('img.md-diagram__image').exists(), true);
  assert.equal(wrapper.get('img').attributes('width'), '120');
  assert.equal(wrapper.get('img').attributes('height'), '80');
  assert.equal(wrapper.get('img').attributes('alt'), 'Схема Mermaid');
  assert.equal(wrapper.get('img').attributes('src'), 'data:image/svg+xml;charset=utf-8,%3Csvg%3E');
});

test('RMD-DIAG-03: переключение на код и обратно без повторной отрисовки', async (t) => {
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, { code: CODE, closed: true });

  await flushPromises();
  await wrapper.get('[data-context="md-diagram-code"]').trigger('click');
  assert.equal(wrapper.find('img').exists(), false);
  assert.equal(wrapper.get('pre').element.textContent, CODE);
  await wrapper.get('[data-context="md-diagram-show"]').trigger('click');
  assert.equal(wrapper.find('img').exists(), true);
  assert.equal(calls.mermaid.length, 1);
});

test('RMD-DIAG-04: ошибка — код и пояснение', async (t) => {
  const { wrapper, flushPromises } = await mountMarkdown(t, FILE, { code: CODE, closed: true }, {
    mermaid: async () => null,
  });

  await flushPromises();
  assert.equal(wrapper.find('img').exists(), false);
  assert.equal(wrapper.get('pre').element.textContent, CODE);
  assert.equal(wrapper.get('.md-diagram__error').text(), 'Схему не удалось нарисовать, показан код.');
  assert.equal(wrapper.find('[data-context="md-diagram-show"]').exists(), false);
});

test('RMD-DIAG-05: поздняя схема прежнего кода отбрасывается', async (t) => {
  const releases = [];
  const { wrapper, flushPromises } = await mountMarkdown(t, FILE, { code: CODE, closed: true }, {
    mermaid: () => new Promise((resolve) => releases.push(resolve)),
  });

  await wrapper.setProps({ code: 'flowchart TD\n B-->C' });
  releases[1]({
    src: 'data:image/svg+xml,B',
    width: 20,
    height: 30,
  });
  await flushPromises();
  releases[0]({
    src: 'data:image/svg+xml,A',
    width: 120,
    height: 80,
  });
  await flushPromises();
  assert.equal(wrapper.get('img').attributes('src'), 'data:image/svg+xml,B');
});

test('RMD-DIAG-06: смена текста/unmount отменяет запрос, img error возвращает код', async (t) => {
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, { code: CODE, closed: true });

  await flushPromises();
  assert.equal(Boolean(calls.mermaid[0][1]?.signal), true);
  await wrapper.setProps({ code: 'flowchart TD\n B-->C' });
  assert.equal(calls.mermaid[0][1].signal.aborted, true);
  await flushPromises();
  await wrapper.get('img').trigger('error');
  assert.equal(wrapper.find('img').exists(), false);
  assert.equal(wrapper.find('.md-diagram__error').exists(), true);
  assert.equal(wrapper.get('pre').element.textContent, 'flowchart TD\n B-->C');
  assert.equal(calls.mermaid.length, 2);
  wrapper.unmount();
  assert.equal(calls.mermaid[1][1].signal.aborted, true);
});
