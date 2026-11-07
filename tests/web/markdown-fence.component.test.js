import assert from 'node:assert/strict';
import test from 'node:test';

import { mountMarkdown } from './helpers/rich-markdown.js';

const FILE = 'src/shared/markdown/FenceCode.vue';

test('RMD-FENCE-01: открытый блок — простой код без подсветки', async (t) => {
  const { wrapper, calls } = await mountMarkdown(t, FILE, {
    code: 'const a = 1;',
    lang: 'ts',
    closed: false,
  });

  assert.equal(calls.highlight.length, 0);
  assert.equal(wrapper.get('pre').element.textContent, 'const a = 1;');
  assert.equal(wrapper.find('.md-fence__lang').exists(), true);
  assert.equal(wrapper.find('.md-fence__lang').text(), 'ts');
  assert.equal(wrapper.attributes('data-lang'), 'ts');
});

test('RMD-FENCE-02: закрытый блок подсвечивается, текст тот же', async (t) => {
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, {
    code: 'const a = 1;',
    lang: 'ts',
    closed: true,
  }, {
    highlight: async () => [[
      { content: 'const', color: 'var(--md-code-token-keyword)' }, { content: ' a = 1;' },
    ]],
  });

  await flushPromises();
  assert.deepEqual(calls.highlight, [['const a = 1;', 'ts']]);
  assert.equal(wrapper.find('span[style*="--md-code-token-keyword"]').exists(), true);
  assert.equal(wrapper.get('pre').element.textContent, 'const a = 1;');
});

test('RMD-FENCE-03: поздняя подсветка и copy после unmount не публикуются', async (t) => {
  const releases = [];
  let releaseCopy;
  const { wrapper, flushPromises } = await mountMarkdown(t, FILE, {
    code: 'const a = 1;',
    lang: 'ts',
    closed: true,
  }, {
    highlight: () => new Promise((resolve) => releases.push(resolve)),
    clipboard: () => new Promise((resolve) => {
      releaseCopy = resolve;
    }),
  });

  await wrapper.setProps({ code: 'let b = 2;' });
  releases[1]([[{ content: 'let b = 2;' }]]);
  await flushPromises();
  releases[0]([[{ content: 'const a = 1;' }]]);
  await flushPromises();
  assert.equal(wrapper.get('pre').element.textContent, 'let b = 2;');
  await wrapper.get('[data-context="md-fence-copy"]').trigger('click');

  const setTimeoutOriginal = globalThis.setTimeout;
  let copiedTimers = 0;

  t.mock.method(globalThis, 'setTimeout', (...args) => {
    if (args[1] === 1500) {
      copiedTimers += 1;
    }

    return setTimeoutOriginal(...args);
  });
  wrapper.unmount();
  releaseCopy(true);
  await flushPromises();
  assert.equal(copiedTimers, 0);
});

test('RMD-FENCE-04: дифф размечен строками без shiki', async (t) => {
  const { wrapper, calls } = await mountMarkdown(t, FILE, {
    code: '@@ -1 +1 @@\n-old\n+new',
    lang: 'diff',
    closed: true,
  });

  for (const kind of ['hunk', 'del', 'add']) {
    assert.equal(wrapper.findAll(`.md-line--${kind}`).length, 1);
  }

  assert.equal(calls.highlight.length, 0);
});

test('RMD-FENCE-05: копирование отдаёт исходник и меняет подпись', async (t) => {
  const { wrapper, calls, flushPromises } = await mountMarkdown(t, FILE, {
    code: 'a  \n\tb',
    lang: '',
    closed: true,
  });

  await wrapper.get('[data-context="md-fence-copy"]').trigger('click');
  await flushPromises();
  assert.deepEqual(calls.clipboard, [['a  \n\tb']]);
  assert.equal(wrapper.get('[data-context="md-fence-copy"]').attributes('aria-label'), 'Скопировано');
});

test('RMD-FENCE-06: длинный блок свёрнут и раскрывается', async (t) => {
  const { wrapper } = await mountMarkdown(t, FILE, {
    code: Array(30).fill('x').join('\n'),
    lang: 'text',
    closed: true,
  });

  assert.equal(wrapper.classes().includes('md-fence--collapsed'), true);
  await wrapper.get('[data-context="md-fence-expand"]').trigger('click');
  assert.equal(wrapper.classes().includes('md-fence--collapsed'), false);
  assert.equal(wrapper.get('[data-context="md-fence-expand"]').attributes('aria-expanded'), 'true');
  await wrapper.setProps({ code: 'a\nb\nc' });
  assert.equal(wrapper.find('[data-context="md-fence-expand"]').exists(), false);
});

test('RMD-FENCE-07: в слот tools встают дополнительные кнопки', async (t) => {
  const { wrapper } = await mountMarkdown(t, FILE, {
    code: 'x',
    lang: '',
    closed: true,
  }, { slots: { tools: '<span data-probe="extra">x</span>' } });

  assert.equal(wrapper.find('.md-fence__tools [data-probe="extra"]').exists(), true);
});

test('RMD-FENCE-08: отказ буфера не показывает Скопировано', async (t) => {
  const { wrapper, flushPromises } = await mountMarkdown(t, FILE, {
    code: 'x',
    lang: '',
    closed: true,
  }, { clipboard: async () => false });

  await wrapper.get('[data-context="md-fence-copy"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('[data-context="md-fence-copy"]').attributes('aria-label'), 'Копировать код');
});
