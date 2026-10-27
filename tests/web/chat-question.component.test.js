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

async function mountQuestion(t, questions, req = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/chats');
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
        ...req,
      },
    },
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

function button(wrapper, label) {
  return wrapper.findAll('button').find((entry) => entry.text() === label);
}

test('вопрос без вариантов сразу принимает многострочный ответ через Ctrl+Enter', async (t) => {
  const wrapper = await mountQuestion(t, [{
    header: 'Пояснение',
    question: 'Что изменить?',
  }]);
  const field = wrapper.get('textarea');

  assert.equal(wrapper.find('.ui-choice-list').exists(), false);
  assert.equal(button(wrapper, 'Ответить').attributes('disabled'), '');
  await field.setValue('  Первая строка\nВторая строка  ');
  await field.trigger('keydown', { key: 'Enter' });
  assert.equal(wrapper.emitted('answer'), undefined);
  await field.trigger('keydown', { key: 'Enter', ctrlKey: true });

  assert.equal(wrapper.emitted('answer')[0][0][0].text, 'Первая строка\nВторая строка');
});

test('счётчик ответов обновляется, новый запрос очищает выбор и текст', async (t) => {
  const questions = [
    { question: 'Первый?', options: [{ label: 'Да' }] },
    { question: 'Второй?' },
  ];
  const wrapper = await mountQuestion(t, questions);

  assert.equal(wrapper.get('.q-progress').text(), 'Ответов: 0 из 2');
  await wrapper.get('.ui-choice-list__option').trigger('click');
  await wrapper.get('textarea').setValue('Ответ');
  assert.equal(wrapper.get('.q-progress').text(), 'Ответов: 2 из 2');

  await wrapper.setProps({ req: { pid: 'next-request', questions } });

  assert.equal(wrapper.get('.q-progress').text(), 'Ответов: 0 из 2');
  assert.equal(wrapper.get('textarea').element.value, '');
  assert.equal(wrapper.get('.ui-choice-list__option').attributes('aria-selected'), 'false');
  assert.equal(wrapper.emitted('answer'), undefined);
});

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
  const indicators = wrapper.findAll('.ui-choice-list__indicator');

  assert.equal(button(wrapper, 'Ответить').attributes('disabled'), '');
  assert.equal(
    wrapper.get('.ui-choice-list').attributes('data-selection-indicator'),
    'true',
  );
  assert.equal(indicators.length, 2);
  assert.equal(indicators[0].attributes('data-mode'), 'single');
  assert.equal(choices[0].get('.ui-choice-list__label').text(), 'Быстро');
  assert.equal(
    choices[0].get('.ui-choice-list__description').text(),
    'Только минимальная правка',
  );

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

  assert.equal(
    wrapper.get('.ui-choice-list__indicator').attributes('data-mode'),
    'multiple',
  );

  await choices[0].trigger('click');
  await choices[1].trigger('click');
  await button(wrapper, 'свой ответ…').trigger('click');
  assert.equal(wrapper.get('textarea').element === document.activeElement, true);
  await wrapper.get('textarea[placeholder="напиши своими словами"]').setValue('  И typecheck  ');
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

test('structured-форма сохраняет типы и raw values отдельно от подписей', async (t) => {
  const wrapper = await mountQuestion(t, [
    {
      key: 'name',
      header: 'Имя',
      question: 'Имя окружения',
      inputType: 'text',
      required: true,
      minLength: 2,
    },
    {
      key: 'replicas',
      header: 'Реплики',
      question: 'Количество реплик',
      inputType: 'integer',
      required: true,
      minimum: 1,
    },
    {
      key: 'starts_at',
      header: 'Старт',
      question: 'Когда запустить?',
      inputType: 'text',
      format: 'date-time',
      required: true,
    },
    {
      key: 'enabled',
      header: 'Запуск',
      question: 'Запустить сразу?',
      inputType: 'boolean',
      required: true,
    },
    {
      key: 'mode',
      header: 'Режим',
      question: 'Какой режим?',
      inputType: 'choice',
      required: true,
      options: [{ value: 'safe_mode', label: 'Безопасный' }],
    },
    {
      key: 'checks',
      header: 'Проверки',
      question: 'Что проверить?',
      inputType: 'multi-choice',
      multiSelect: true,
      required: true,
      minItems: 1,
      options: [
        { value: 'unit_tests', label: 'Тесты' },
        { value: 'build', label: 'Сборка' },
      ],
    },
  ], {
    structured: true,
    source: 'MCP · deploy',
    prompt: 'Настрой окружение',
    actions: ['accept', 'cancel'],
  });

  assert.match(wrapper.text(), /MCP · deploy/u);
  assert.match(wrapper.text(), /Настрой окружение/u);
  assert.equal(button(wrapper, 'Отправить').attributes('disabled'), '');

  const inputs = wrapper.findAll('input');
  await inputs[0].setValue('stage');
  await inputs[1].setValue('3');
  await inputs[2].setValue('2026-08-31T12:30');
  const lists = wrapper.findAll('.ui-choice-list');
  await lists[0].findAll('.ui-choice-list__option')[1].trigger('click');
  await lists[1].find('.ui-choice-list__option').trigger('click');
  await lists[2].findAll('.ui-choice-list__option')[0].trigger('click');

  assert.equal(button(wrapper, 'Отправить').attributes('disabled'), undefined);
  await button(wrapper, 'Отправить').trigger('click');

  assert.deepEqual(wrapper.emitted('answer'), [[{
    action: 'accept',
    answers: [
      { key: 'name', value: 'stage' },
      { key: 'replicas', value: 3 },
      { key: 'starts_at', value: new Date('2026-08-31T12:30').toISOString() },
      { key: 'enabled', value: false },
      { key: 'mode', value: 'safe_mode' },
      { key: 'checks', value: ['unit_tests'] },
    ],
  }]]);
});

test('пустая structured-форма отправляет явный исход и отдельные allow-варианты', async (t) => {
  const wrapper = await mountQuestion(t, [], {
    structured: true,
    prompt: 'Разрешить вызов MCP?',
    actions: ['accept_session', 'accept_always', 'cancel'],
  });

  assert.equal(button(wrapper, 'Разрешить на сессию').attributes('disabled'), undefined);
  await button(wrapper, 'Разрешить на сессию').trigger('click');
  await button(wrapper, 'Разрешать всегда').trigger('click');
  await button(wrapper, 'Отменить').trigger('click');

  assert.deepEqual(wrapper.emitted('answer'), [
    [{ action: 'accept_session', answers: [] }],
    [{ action: 'accept_always', answers: [] }],
    [{ action: 'cancel', answers: [] }],
  ]);
});

test('structured decline не маскируется пустым массивом ответов', async (t) => {
  const wrapper = await mountQuestion(t, [], {
    structured: true,
    actions: ['accept', 'decline', 'cancel'],
  });

  await button(wrapper, 'Отклонить').trigger('click');

  assert.deepEqual(wrapper.emitted('answer'), [[{ action: 'decline', answers: [] }]]);
});
