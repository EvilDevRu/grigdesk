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

test('unsupported сохраняет обсуждение, но не разрешает применение и старую форму возврата', async (t) => {
  const { wrapper } = await fixture(t, { unsupported: true });

  assert.equal(wrapper.get('[data-role="arbiter-apply"]').attributes('disabled') !== undefined, true);
  assert.equal(wrapper.find('[data-role="arbiter-discuss-input"]').exists(), true);
  assert.equal(wrapper.find('[data-role="pipeline-arbiter-decision"]').exists(), false);
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
