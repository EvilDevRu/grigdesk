import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from '../../web/node_modules/happy-dom/lib/index.js';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const browser = new Window({ url: 'http://arbiter.test' });

for (const name of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'SVGElement',
  'Element', 'Node', 'Event', 'CustomEvent']) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: name === 'window' ? browser : browser[name]
  });
}

after(() => browser.happyDOM.close());

const vueUtils = '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';
const { mount, flushPromises } = await import(vueUtils);
const { reactive } = await import('../../web/node_modules/vue/index.mjs');

/**
 * Сеть подменена на границе store, поэтому проверяются реальные поля и кнопки SFC.
 * Текст вопросов и ответов остаётся данными, не ключами локализации.
 */
async function fixture(t, { unsupported = false, readOnly = false } = {}) {
  const identity = {
    task: '7',
    profile: 'demo',
    attempt: `a_${'a'.repeat(32)}`,
    node: 'check',
    stop: 'human',
    stageSequence: 2,
    stageHeadHash: 'b'.repeat(64)
  };
  const targets = [{
    node: 'author',
    label: 'Подготовка проверок',
    executorKind: 'agent',
    acceptsInstruction: true,
    canRetryUnchanged: false,
    resetNodes: ['Подготовка проверок', 'Проверка']
  }];
  const capabilities = {
    status: unsupported ? 'unsupported' : 'supported',
    message: unsupported ? 'Защищённое применение недоступно в старой попытке.' : '',
    targets
  };
  const doc = reactive({
    id: `c_${'a'.repeat(32)}`,
    identity,
    revision: 4,
    decisionRevision: 2,
    state: 'awaiting_user',
    readOnly,
    capabilities,
    automatic: true,
    messages: [{
      id: 'node',
      author: 'node',
      text: 'Проверка прервалась по времени.'
    },
    {
      id: 'arbiter',
      author: 'arbiter',
      text: 'Читаю журнал.'
    }],
    operations: [],
    result: {
      summary: 'Причина пока неизвестна. Сначала выясним, где остановилось выполнение.',
      technicalDetails: '/private/path command argv',
      questions: [{
        id: 'q',
        text: 'Журнал сохранился?',
        options: [{ id: 'yes', label: 'settings.arbiter' }],
        allowCustom: true
      }],
      proposals: [
        {
          id: 'd',
          kind: 'diagnose',
          label: 'Изучить журнал',
          explanation: 'Прочитаю сведения.',
          expectedResult: 'Причина',
          diagnosticInstruction: 'Прочитай журнал',
          recommended: true
        },
        {
          id: 'p',
          kind: 'apply',
          label: 'Передать исправление',
          explanation: 'Возврат автору.',
          expectedResult: 'Повтор этапа',
          action: {
            kind: 'return_to_node',
            targetNode: 'author',
            instruction: 'Исправь проверки.'
          },
          recommended: false
        },
      ]
    }
  });
  const draft = reactive({
    text: '',
    instruction: '',
    targetNode: '',
    custom: false,
    answers: {}
  });
  const calls = [];

  globalThis.arbiterComponentStore = reactive({
    currentByTask: {
      '7': {
        identity,
        conversationId: doc.id,
        capabilities
      }
    },
    pending: {},
    sending: {},
    errors: {},
    document: () => doc,
    draftFor: () => draft,
    open: async () => { },
    send: async (...args) => {
      calls.push(args);

      return { operationId: 'ack' };
    },
    retryPending: async () => { }
  });

  const component = await compileVue(webFile('src/views/pipeline/ArbiterConversation.vue'), {
    stubs: {
      '../../stores/arbiterConversations.ts': ("export const useArbiterConversationsStore = () => " +
        "globalThis.arbiterComponentStore;"),
    }
  });
  const wrapper = mount(component, { props: { task: '7', node: 'check' }, attachTo: browser.document.body });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return {
    wrapper,
    calls,
    doc,
    draft,
    flushPromises
  };
}

test('единый блок показывает источник, ход, итог и раздельные обсуждение/диагностику/apply', async (t) => {
  const { wrapper, calls, draft, flushPromises } = await fixture(t);

  assert.match(wrapper.text(), /Проверка прервалась по времени/);
  assert.equal(document.activeElement?.getAttribute('data-role'), 'arbiter-discuss-input');
  assert.match(wrapper.text(), /Читаю журнал/);
  assert.match(wrapper.text(), /Причина пока неизвестна/);
  assert.equal(wrapper.text().includes('/private/path'), false);
  assert.match(wrapper.text(), /исправление выбираете вы/);
  draft.text = 'Что уже установлено?';
  await flushPromises();
  await wrapper.get('[data-role="arbiter-discuss"]').trigger('click');
  await wrapper.get('[data-role="arbiter-diagnose"]').trigger('click');
  await wrapper.get('[data-role="arbiter-apply"]').trigger('click');

  assert.deepEqual(calls.map((row) => row[2]), ['discuss', 'diagnose', 'apply']);
  assert.equal(calls[2][3].proposalId, 'p');
  assert.match(wrapper.text(), /Подготовка проверок/);
  assert.equal(wrapper.text().includes('settings.arbiter'), true);
});

test('рекомендованный ответ выделен, а выбор сохраняет исходный вопрос и id варианта', async (t) => {
  const { wrapper, calls, doc, draft, flushPromises } = await fixture(t);

  doc.result.questions[0].options = [
    { id: 'keep', label: 'Оставить проверку неизменной' },
    { id: 'defer', label: 'Решить после следующего плана (Рекомендуется)' },
    { id: 'inspect', label: 'Inspect the next plan (Recommended)' },
    { id: 'literal', label: 'Не рекомендуется менять проверку' },
    { id: 'middle', label: 'Вариант (Recommended) ещё обсуждается' },
  ];
  draft.answers.q = 'Мой ответ';
  await flushPromises();

  const options = wrapper.findAll('[data-context="arbiter-question-option"]');

  assert.deepEqual(options.map((option) => option.attributes('data-tone')),
    ['neutral', 'success', 'success', 'neutral', 'neutral']);
  assert.equal(options[1].attributes('data-variant'), 'solid');
  assert.equal(options[1].find('.ac-option-recommendation').exists(), true);
  assert.equal(options[1].text().includes('(Рекомендуется)'), false);
  assert.match(options[1].text(), /Решить после следующего плана/);
  assert.equal(doc.result.questions[0].options[1].label,
    'Решить после следующего плана (Рекомендуется)');
  assert.equal(wrapper.get('[data-role="arbiter-diagnose"]').attributes('data-tone'), 'success');
  assert.equal(wrapper.get('[data-role="arbiter-apply"]').attributes('data-tone'), 'neutral');
  await options[1].trigger('click');

  assert.deepEqual(calls[0].slice(2), ['discuss', { questionId: 'q', optionId: 'defer' }]);
  assert.equal(draft.answers.q, 'Мой ответ');
  doc.state = 'analyzing';
  await flushPromises();

  assert.equal(wrapper.findAll('[data-context="arbiter-question-option"]')
    .every((option) => option.attributes('disabled') !== undefined), true);
});

test('свой текст требует этап и последствия; SSE сохраняет черновик; busy закрывает отправку', async (t) => {
  const { wrapper, calls, draft, doc, flushPromises } = await fixture(t);

  draft.text = 'Не потерять';
  draft.custom = true;
  draft.instruction = 'Исправь причину в генераторе';
  await flushPromises();

  assert.equal(wrapper.get('[data-role="arbiter-custom-apply"]').attributes('disabled') !== undefined, true);
  draft.targetNode = 'author';
  await flushPromises();
  await wrapper.get('[data-role="arbiter-custom-apply"]').trigger('click');
  assert.equal(calls[0][3].customAction.instruction, draft.instruction);
  doc.revision += 1;
  doc.state = 'analyzing';
  await flushPromises();
  assert.equal(draft.text, 'Не потерять');
  assert.equal(wrapper.get('[data-role="arbiter-discuss"]').attributes('disabled') !== undefined, true);
});

test('источник отделён от реплик, а автор итога и сообщения человека обозначены явно', async (t) => {
  const { wrapper, doc, flushPromises } = await fixture(t);

  doc.messages.push({
    id: 'human-reply',
    author: 'human',
    text: 'Проверь последний запуск.',
    createdAt: '2026-01-20T12:30:00Z',
  });
  await flushPromises();

  assert.equal(wrapper.find('.ac-messages [data-author="node"]').exists(), false);
  assert.match(wrapper.get('.ac-source').text(), /Исполнитель этапа/);
  assert.equal(wrapper.get('[data-role="arbiter-source-disclosure"]').attributes('aria-expanded'), 'false');
  assert.equal(wrapper.get('.ac-messages [data-author="human"] .ac-author').text(), 'Вы');
  assert.equal(wrapper.findAll('.ac-messages [data-author="arbiter"] .ac-author')
    .every((label) => label.text() === 'Арбитр'), true);
  assert.equal(wrapper.get('.ac-messages [data-author="human"] time').attributes('datetime'),
    '2026-01-20T12:30:00Z');

  await wrapper.get('[data-role="arbiter-source-disclosure"]').trigger('click');
  doc.revision += 1;
  await flushPromises();

  assert.equal(wrapper.get('[data-role="arbiter-source-disclosure"]').attributes('aria-expanded'), 'true');
  assert.equal(wrapper.get('.ac-source p').classes().includes('ac-source-preview'), false);
});

test('ожидание ответа занимает ширину обсуждения, а варианты появляются после разбора', async (t) => {
  const { wrapper, doc, draft, flushPromises } = await fixture(t);

  draft.text = 'Уточнение к разбору';
  doc.state = 'analyzing';
  doc.result = null;
  await flushPromises();

  assert.match(wrapper.get('.ac-status').text(), /На связи/);
  assert.equal(wrapper.find('[data-role="arbiter-thinking"]').exists(), true);
  assert.equal(wrapper.find('.ac-decisions').exists(), false);
  assert.equal(wrapper.get('[data-role="arbiter-discuss"]').attributes('disabled') !== undefined, true);

  doc.messages[1].status = 'partial';
  await flushPromises();

  assert.equal(wrapper.find('[data-role="arbiter-thinking"]').exists(), false);
  assert.match(wrapper.get('[data-author="arbiter"] .ac-message-state').text(), /пишет/);

  doc.messages[1].status = 'complete';
  doc.state = 'awaiting_user';
  await flushPromises();

  assert.equal(wrapper.find('.ac-decisions').exists(), true);
  assert.equal(wrapper.find('[data-role="arbiter-thinking"]').exists(), false);
  assert.equal(wrapper.get('[data-role="arbiter-discuss"]').attributes('disabled'), undefined);
});

test('unsupported сохраняет обсуждение, но не разрешает применение и старую форму возврата', async (t) => {
  const { wrapper } = await fixture(t, { unsupported: true });

  assert.equal(wrapper.get('[data-role="arbiter-apply"]').attributes('disabled') !== undefined, true);
  assert.equal(wrapper.find('[data-role="arbiter-discuss-input"]').exists(), true);
  assert.equal(wrapper.find('[data-role="pipeline-arbiter-decision"]').exists(), false);
});

test('без вопросов остаются предложения и свободный ответ; законченные уточнения не показывают заглушку',
  async (t) => {
    const { wrapper, calls, doc, draft, flushPromises } = await fixture(t);

    doc.result.questions = [];
    doc.result.nextStep = 'choose_proposal';
    await flushPromises();

    assert.equal(wrapper.find('.ac-question').exists(), false);
    assert.equal(wrapper.find('[data-role="arbiter-diagnose"]').exists(), true);
    assert.equal(wrapper.find('[data-role="arbiter-discuss-input"]').exists(), true);
    assert.equal(wrapper.find('.ac-decision-empty').exists(), false);
    assert.match(wrapper.get('.ac-status').text(), /Уточнений больше нет; выберите предложение/u);

    doc.result.proposals = [];
    doc.result.nextStep = 'continue_discussion';
    await flushPromises();

    assert.equal(wrapper.find('.ac-decisions').exists(), false);
    assert.equal(wrapper.find('[data-role="arbiter-analysis-failure"]').exists(), false);
    assert.match(wrapper.get('.ac-status').text(), /Решения учтены/u);
    draft.text = 'Продолжим после плана.';
    await flushPromises();
    await wrapper.get('[data-role="arbiter-discuss"]').trigger('click');

    assert.deepEqual(calls[0].slice(2), ['discuss', { text: 'Продолжим после плана.' }]);
  });

test('сбой разбора виден рядом с ручным повтором и не оставляет обещания будущих вариантов', async (t) => {
  const { wrapper, doc, calls, flushPromises } = await fixture(t);

  doc.result = null;
  doc.state = 'interrupted';
  doc.operations.push({
    id: 'failed-turn',
    kind: 'start',
    outcome: 'failed',
    message: 'Арбитр прислал некорректные варианты решения.',
  });
  await flushPromises();

  assert.match(wrapper.get('[data-role="arbiter-analysis-failure"]').text(), /некорректные варианты/);
  assert.match(wrapper.get('[data-role="arbiter-analysis-failure"]').text(), /Конвейер остаётся на паузе/);
  assert.equal(wrapper.find('.ac-decision-empty').exists(), false);
  assert.equal(wrapper.find('[data-role="arbiter-apply"]').exists(), false);
  await wrapper.get('.ac-decisions [data-role="arbiter-start"]').trigger('click');
  assert.deepEqual(calls.map((row) => row[2]), ['start']);

  doc.state = 'analyzing';
  await flushPromises();
  assert.equal(wrapper.find('[data-role="arbiter-analysis-failure"]').exists(), false);
  assert.equal(wrapper.find('[data-role="arbiter-start"]').exists(), false);
});

test('старый сбой берёт причину из истории, служебная опечатка исчезает только у арбитра', async (t) => {
  const { wrapper, doc, flushPromises } = await fixture(t, { readOnly: true });

  doc.result = null;
  doc.state = 'interrupted';
  doc.messages[1].text = '\nПричина найдена.\n</arbriter-message>\n';
  doc.messages.push({
    id: 'system',
    author: 'system',
    text: 'Прежний итог не соответствует контракту.',
  });
  doc.messages.push({
    id: 'human',
    author: 'human',
    text: 'Проверь тег </arbriter-message>',
  });
  await flushPromises();

  assert.match(wrapper.get('[data-role="arbiter-analysis-failure"]').text(), /не соответствует контракту/);
  assert.equal(wrapper.get('[data-author="arbiter"] p').text(), 'Причина найдена.');
  assert.equal(wrapper.get('[data-author="human"] p').text(), 'Проверь тег </arbriter-message>');
  assert.equal(wrapper.find('[data-role="arbiter-start"]').exists(), false);
});

test('история не содержит активных apply; resume_failed предлагает только повтор запуска', async (t) => {
  const { wrapper, doc, calls, flushPromises } = await fixture(t, { readOnly: true });

  assert.equal(wrapper.find('[data-role="arbiter-apply"]').exists(), false);
  doc.state = 'resolved';
  doc.operations.push({
    id: 'apply',
    kind: 'apply',
    outcome: 'resume_failed',
    receipt: { stage: { sequence: 3, headEventHash: 'c'.repeat(64) } },
  });
  await flushPromises();
  await wrapper.get('[data-role="arbiter-resume"]').trigger('click');
  assert.deepEqual(calls.map((call) => call[2]), ['resume']);
  assert.equal(calls[0][3].applyOperationId, 'apply');
  doc.operations[0].observation = 'completed';
  await flushPromises();
  assert.equal(wrapper.find('[data-role="arbiter-resume"]').exists(), false);
});
