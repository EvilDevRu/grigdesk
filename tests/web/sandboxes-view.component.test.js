// Страница «Песочницы»: подъём и снос — необратимые действия, поэтому оба проходят
// через подтверждение человека, а стенд, которым владеет попытка конвейера, не даёт
// кнопки сноса вовсе — им управляет карточка задачи. Сеть страницы не касается:
// подменяется слой операций раздела, а проверяется то, что страница ему передаёт.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const VIEW = webFile('src/views/SandboxesView.vue');

// Элементы управления остаются настоящими: подменяется только решение человека
// в диалоге, чтобы проверялось поведение самой страницы.
const UI_STUB = `
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiIconButton } from '${webFile('src/components/primitives/UiIconButton.vue')}';
export { default as UiInput } from '${webFile('src/components/primitives/UiInput.vue')}';
export { default as UiSelect } from '${webFile('src/components/primitives/UiSelect.vue')}';
export { default as UiSwitch } from '${webFile('src/components/primitives/UiSwitch.vue')}';
export { default as UiField } from '${webFile('src/components/composites/UiField.vue')}';
export { default as UiFormActions } from '${webFile('src/components/composites/UiFormActions.vue')}';
export { default as UiDisclosureButton } from '${webFile('src/components/composites/UiDisclosureButton.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export { default as UiProgress } from '${webFile('src/components/feedback/UiProgress.vue')}';
export const confirmDialog = async (text, options) => {
  globalThis.__sandboxViewHarness.confirmations.push({ text, options });
  return globalThis.__sandboxViewHarness.confirmed;
};
export const promptDialog = async (options) => {
  globalThis.__sandboxViewHarness.prompts.push(options);
  return globalThis.__sandboxViewHarness.answers.shift() ?? null;
};
`;

// Операции раздела — двойники: страница обязана звать их, а не ходить в сеть сама.
const ACTIONS_STUB = `
export const useSandboxesStore = () => globalThis.__sandboxViewHarness.store;
export const watchSandboxes = () => {
  globalThis.__sandboxViewHarness.calls.push(['watch']);
};
export const loadSandboxes = async () => {
  globalThis.__sandboxViewHarness.calls.push(['load']);
};
export const raiseSandbox = async (profile, task) => {
  globalThis.__sandboxViewHarness.calls.push(['raise', profile, task]);
};
export const dismantleSandbox = async (task, force) => {
  globalThis.__sandboxViewHarness.calls.push(['dismantle', task, force]);
};
export const runSandboxAction = async (task, action, args) => {
  globalThis.__sandboxViewHarness.calls.push(['run', task, action, args]);
  return true;
};
export const loadSandboxJobLog = async (task) => {
  globalThis.__sandboxViewHarness.calls.push(['log', task]);
  return { task, action: 'run', state: 'done', text: 'ИТОГ: все звенья СОВПАДАЮТ', truncated: false };
};
`;

const ACTION = {
  id: 'scan-schedule',
  label: 'Плановый съём',
  description: 'Гонит плановый съём проекта целиком.',
  args: [{ key: 'project', label: 'Номер проекта', type: 'number', required: true, hint: 'из песочницы' }],
  confirm: 'Спишет лимиты пользователя песочницы.',
};

function entry(overrides = {}) {
  return {
    task: '990000',
    profile: 'demo-profile',
    owner: 'manual',
    slot: 0,
    fePort: 5190,
    apiPort: 8090,
    repos: [{ name: 'backend', path: '/srv/worktrees/backend', branch: 'route-task-990000' }],
    standAlive: true,
    removable: true,
    removableReason: null,
    updatedAt: null,
    ...overrides,
  };
}

/**
 * Страница монтируется на двойнике стора: проверяется, что она спрашивает человека
 * и передаёт службе именно то, что он выбрал. Настоящих стендов здесь нет.
 */
async function mountView(t, {
  sandboxes = [entry()], jobs = [], confirmed = true, answers = [],
} = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/sandboxes');
  const calls = [];
  const harness = {
    confirmed,
    confirmations: [],
    prompts: [],
    answers,
    calls,
    store: {
      profiles: [{ id: 'demo-profile', canRaise: true, reason: null }],
      sandboxes,
      jobs,
      manualRange: { from: 990000, to: 999999 },
      loading: false,
      loaded: true,
      error: '',
      busyTasks: [],
      capableProfiles: [{ id: 'demo-profile', canRaise: true, reason: null }],
      manualSandboxes: sandboxes.filter((item) => item.owner === 'manual'),
      pipelineSandboxes: sandboxes.filter((item) => item.owner === 'pipeline'),
      orphanJobs: jobs.filter((job) => !sandboxes.some((item) => item.task === job.task)),
      jobOf: (task) => jobs.find((job) => job.task === task) || null,
      isBusy: () => false,
    },
  };

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');

  harness.store = reactive(harness.store);
  globalThis.__sandboxViewHarness = harness;

  const component = await compileVue(VIEW, {
    stubs: {
      '../actions/sandboxes': ACTIONS_STUB,
      '../../actions/sandboxes': ACTIONS_STUB,
      '../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      '../../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__sandboxViewHarness;
  });

  await flushPromises();

  return {
    wrapper, flushPromises, calls, harness,
  };
}

test('подъём без задачи подтверждается и уходит в службу служебным номером', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t, { sandboxes: [] });

  await wrapper.find('form').trigger('submit');
  await flushPromises();

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0].text, /служебный номер/i);
  assert.deepEqual(calls.filter(([kind]) => kind === 'raise'), [['raise', 'demo-profile', null]]);
});

test('отказ человека в диалоге не поднимает стенд', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, { sandboxes: [], confirmed: false });

  await wrapper.find('form').trigger('submit');
  await flushPromises();

  assert.deepEqual(calls.filter(([kind]) => kind === 'raise'), []);
});

test('обычный снос бережёт незакоммиченное, а второй кнопкой оно сносится явно', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t);
  const buttons = wrapper.findAll('.sandbox-card__actions button');

  assert.deepEqual(buttons.map((button) => button.text()), [
    'Снести вместе с незакоммиченным',
    'Снести стенд',
  ]);

  await buttons[1].trigger('click');
  await flushPromises();
  await wrapper.findAll('.sandbox-card__actions button')[0].trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([kind]) => kind === 'dismantle'), [
    ['dismantle', '990000', false],
    ['dismantle', '990000', true],
  ]);
  assert.match(harness.confirmations[0].text, /сохраняется/i);
  assert.match(harness.confirmations[1].text, /вместе с незакоммиченными/i);
});

test('стенд конвейера показан без кнопок сноса', async (t) => {
  const { wrapper } = await mountView(t, {
    sandboxes: [entry({
      task: '4242', owner: 'pipeline', removable: false, removableReason: 'pipeline_owned',
    })],
  });

  assert.equal(wrapper.findAll('.sandbox-card__actions button').length, 0);
  assert.match(wrapper.text(), /владеет конвейер/i);
});

test('идущий подъём показан шагом, а не пустой карточкой', async (t) => {
  const { wrapper } = await mountView(t, {
    sandboxes: [entry({
      fePort: null, apiPort: null, standAlive: null, removable: false, removableReason: 'job_running',
    })],
    jobs: [{
      task: '990000',
      profile: 'demo-profile',
      action: 'up',
      state: 'running',
      index: 4,
      total: 11,
      label: 'клон db: данные',
      message: '',
      startedAt: '2026-09-07T10:00:00.000Z',
      finishedAt: null,
    }],
  });

  assert.match(wrapper.text(), /клон db: данные/);
  assert.equal(wrapper.find('[role="progressbar"]').attributes('aria-valuenow'), '4');
});

test('действие профиля спрашивает аргументы, подтверждение и уходит в службу', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t, {
    sandboxes: [entry({ actions: [ACTION] })],
    answers: ['389'],
  });
  const button = wrapper.findAll('.sandbox-card__runs button').find((item) => item.text() === 'Плановый съём');

  assert.ok(button, 'кнопка действия из манифеста профиля');

  await button.trigger('click');
  await flushPromises();

  assert.equal(harness.prompts.length, 1);
  assert.match(harness.prompts[0].text, /Номер проекта\. из песочницы/);
  assert.match(harness.confirmations[0].text, /Плановый съём на стенде t990000/);
  assert.match(harness.confirmations[0].text, /Спишет лимиты/);
  assert.deepEqual(calls.filter(([kind]) => kind === 'run'), [
    ['run', '990000', 'scan-schedule', { project: '389' }],
  ]);
});

test('отмена вопроса об аргументе не запускает действие и не спрашивает подтверждения', async (t) => {
  const { wrapper, flushPromises, calls, harness } = await mountView(t, {
    sandboxes: [entry({ actions: [ACTION] })],
    answers: [null],
  });

  await wrapper.find('.sandbox-card__runs button').trigger('click');
  await flushPromises();

  assert.equal(harness.confirmations.length, 0);
  assert.deepEqual(calls.filter(([kind]) => kind === 'run'), []);
});

test('итог прогона показан на карточке, а журнал читается по кнопке', async (t) => {
  const { wrapper, flushPromises, calls } = await mountView(t, {
    sandboxes: [entry({ actions: [ACTION], removable: false, removableReason: 'job_running' })],
    jobs: [{
      task: '990000',
      profile: 'demo-profile',
      action: 'run',
      actionId: 'scan-schedule',
      actionLabel: 'Плановый съём',
      state: 'done',
      index: 0,
      total: 0,
      label: 'прогон выполнен',
      message: 'набор проходов: СОВПАДАЕТ',
      startedAt: '2026-09-18T10:00:00.000Z',
      finishedAt: '2026-09-18T10:03:00.000Z',
    }],
  });

  assert.match(wrapper.text(), /набор проходов: СОВПАДАЕТ/);

  const toggle = wrapper.findAll('button').find((item) => /Журнал задания/.test(item.text()));

  assert.ok(toggle, 'кнопка журнала у прогона');
  await toggle.trigger('click');
  await flushPromises();

  assert.deepEqual(calls.filter(([kind]) => kind === 'log'), [['log', '990000']]);
  assert.match(wrapper.find('.sandbox-card__log-text').text(), /все звенья СОВПАДАЮТ/);
});

for (const remaining of [[], [{
  id: 'other',
  canRaise: true,
  reason: null
}]]) {
  test(`PD-raise-catalog: форма сбрасывает удалённый выбранный профиль (${remaining.length} осталось)`,
    async (t) => {
      const { wrapper, harness, calls, flushPromises } = await mountView(t);

      harness.store.profiles = remaining;
      harness.store.capableProfiles = remaining;
      await flushPromises();
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      assert.equal(calls.some(([kind]) => kind === 'raise'), false);
      assert.equal(wrapper.find('select').element.value, '');
      assert.equal(wrapper.text().includes('990000'), true, 'поднятый стенд остаётся на экране');
    });
}
