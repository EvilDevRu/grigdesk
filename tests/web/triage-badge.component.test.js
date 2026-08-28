import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const BADGE_PATH = webFile('src/views/board/TriageBadge.vue');
let badgePromise;

function compileBadge() {
  badgePromise ||= compileVue(BADGE_PATH, {
    stubs: {
      '../../ui': [
        'export const UiTooltip = {',
        '  template: `<section><slot name="trigger" /><slot name="tip" /></section>`,',
        '};',
      ].join('\n'),
    },
  });

  return badgePromise;
}

test('бейдж показывает текст структурного вопроса без object-представления', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, TriageBadge] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileBadge(),
  ]);
  const wrapper = mount(TriageBadge, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      row: {
        analysis: {
          complexity: 3,
          risk: 2,
          diff_size: 'M',
          confidence: 'low',
          questions: [{
            id: 'q-mode',
            text: 'Какой режим оставить?',
            options: [{ id: 'o-manual', label: 'Ручной' }],
          }],
        },
      },
    },
  });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.get('.trow.q').text(), '? Какой режим оставить?');
});

test('бейдж старой оценки показывает строковый вопрос как прежде', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, TriageBadge] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileBadge(),
  ]);
  const wrapper = mount(TriageBadge, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      row: {
        analysis: {
          complexity: 2,
          risk: 1,
          diff_size: 'S',
          confidence: 'low',
          questions: ['Нужно ли сохранить старую подпись?'],
        },
      },
    },
  });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.get('.trow.q').text(), '? Нужно ли сохранить старую подпись?');
});
