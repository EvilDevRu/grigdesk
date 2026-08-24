// Вопрос агента проверяется на реальных UiChoiceList/UiInput, без native controls consumer-а.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileVue,
  webFile,
} from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const QUESTION_PATH = webFile('src/views/chat/ChatQuestion.vue');
let componentPromise;

function compileQuestion() {
  componentPromise ||= compileVue(QUESTION_PATH);

  return componentPromise;
}

async function mountQuestion(t, questions) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/chats');
  const [{ mount }, ChatQuestion] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileQuestion(),
  ]);
  const wrapper = mount(ChatQuestion, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      req: {
        pid: `question-${Date.now()}`,
        chatKey: 'c1',
        questions,
      },
    },
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

function button(wrapper, label) {
  return wrapper.findAll('button').find((entry) => entry.text() === label);
}

test('single-вопрос заменяет выбор и отправляет прежний массив selected', async (t) => {
  const wrapper = await mountQuestion(t, [{
    header: 'Способ',
    question: 'Как продолжить?',
    options: [
      {
        label: 'Быстро',
        description: 'Только минимальная правка',
      },
      {
        label: 'Надёжно',
        description: 'С регрессионным тестом',
      },
    ],
    multiSelect: false,
    allowFreeText: true,
  }]);
  const choices = wrapper.findAll('.ui-choice-list__option');

  assert.equal(button(wrapper, 'Ответить').attributes('disabled'), '');

  await choices[0].trigger('click');
  await choices[1].trigger('click');

  assert.equal(choices[0].attributes('aria-selected'), 'false');
  assert.equal(choices[1].attributes('aria-selected'), 'true');
  assert.equal(button(wrapper, 'Ответить').attributes('disabled'), undefined);

  await button(wrapper, 'Ответить').trigger('click');

  assert.deepEqual(wrapper.emitted('answer'), [[[
    {
      header: 'Способ',
      question: 'Как продолжить?',
      selected: ['Надёжно'],
      text: '',
    },
  ]]]);
});

test('multiple-вопрос и свой текст сохраняются одновременно', async (t) => {
  const wrapper = await mountQuestion(t, [{
    header: 'Проверки',
    question: 'Что прогнать?',
    options: [
      { label: 'Тесты' },
      { label: 'Сборку' },
    ],
    multiSelect: true,
    allowFreeText: true,
  }]);
  const choices = wrapper.findAll('.ui-choice-list__option');

  await choices[0].trigger('click');
  await choices[1].trigger('click');
  await button(wrapper, 'свой ответ…').trigger('click');
  await wrapper.get('input[placeholder="напиши своими словами"]').setValue('  И typecheck  ');
  await button(wrapper, 'Ответить').trigger('click');

  assert.deepEqual(wrapper.emitted('answer')[0][0][0], {
    header: 'Проверки',
    question: 'Что прогнать?',
    selected: ['Тесты', 'Сборку'],
    text: 'И typecheck',
  });
});

test('канал без free text показывает hint и не обещает недоставимый ввод', async (t) => {
  const wrapper = await mountQuestion(t, [{
    header: 'Kimi',
    question: 'Выбери вариант',
    options: [{ label: 'Продолжить' }],
    multiSelect: false,
    allowFreeText: false,
    hint: 'Можно выбрать ровно один вариант',
  }]);

  assert.match(wrapper.text(), /Можно выбрать ровно один вариант/);
  assert.equal(Boolean(button(wrapper, 'свой ответ…')), false);
  assert.equal(wrapper.find('input').exists(), false);
});
