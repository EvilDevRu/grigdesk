// Карточка разрешения сохраняет payload решения и использует public UI facade.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileVue,
  webFile,
} from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const PERMISSION_PATH = webFile('src/views/chat/ChatPermission.vue');
const DIALOG_SERVICE_STUB = `
  export const promptDialog = (options) => globalThis.__chatPermissionPrompt(options);
  export const confirmDialog = () => Promise.resolve(false);
  export const alertDialog = () => Promise.resolve();
`;

let componentPromise;

function compilePermission() {
  componentPromise ||= compileVue(PERMISSION_PATH, {
    stubs: {
      './services/dialogs': DIALOG_SERVICE_STUB,
    },
  });

  return componentPromise;
}

const PLAN_REQ = {
  pid: 'p1',
  chatKey: 'c1',
  tool: 'ExitPlanMode',
  input: {
    plan: 'Шаг 1. Сделать',
  },
};

async function mountPermission(t, req = PLAN_REQ) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/chats');
  globalThis.__chatPermissionPrompt = async () => null;

  const [{ mount, flushPromises }, ChatPermission] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compilePermission(),
  ]);
  const wrapper = mount(ChatPermission, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      req,
    },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return {
    wrapper,
    flushPromises,
  };
}

function button(wrapper, label) {
  return wrapper.findAll('button').find((entry) => entry.text() === label);
}

test('«Доработать» отправляет пояснение третьим аргументом answer', async (t) => {
  const { wrapper, flushPromises } = await mountPermission(t);
  let options;

  globalThis.__chatPermissionPrompt = async (value) => {
    options = value;

    return 'убери лишний шаг';
  };

  await button(wrapper, 'Доработать').trigger('click');
  await flushPromises();

  assert.equal(options.title, 'Что доработать в плане?');
  assert.deepEqual(
    wrapper.emitted('answer'),
    [[false, false, 'убери лишний шаг', '']],
  );
});

test('отмена пояснения оставляет карточку без answer', async (t) => {
  const { wrapper, flushPromises } = await mountPermission(t);

  globalThis.__chatPermissionPrompt = async () => null;
  await button(wrapper, 'Доработать').trigger('click');
  await flushPromises();

  assert.equal(wrapper.emitted('answer'), undefined);
});

test('«Утвердить» отвечает сразу', async (t) => {
  const { wrapper } = await mountPermission(t);

  await button(wrapper, 'Утвердить').trigger('click');

  assert.deepEqual(wrapper.emitted('answer'), [[true, false]]);
});

test('галка сессии использует checked-семантику и доезжает в allow', async (t) => {
  const { wrapper } = await mountPermission(t, {
    pid: 'p-checkbox',
    chatKey: 'c1',
    tool: 'Bash',
    input: {
      command: 'npm test',
    },
  });

  await wrapper.get('input[type="checkbox"]').setValue(true);
  await button(wrapper, 'Разрешить').trigger('click');

  assert.deepEqual(wrapper.emitted('answer'), [[true, true]]);
});

test('запрос Kimi показывает команду и путь вместо сырого JSON', async (t) => {
  const { wrapper } = await mountPermission(t, {
    pid: 'p2',
    chatKey: 'c1',
    tool: 'Bash',
    input: {
      kind: 'execute',
      description: 'Requesting approval to run a command',
      command: 'npm test -- --run',
      file_path: '/home/u/project/package.json',
    },
  });
  const text = wrapper.text();

  assert.match(text, /Requesting approval to run a command/);
  assert.equal(wrapper.find('.p-in.cmd').text(), 'npm test -- --run');
  assert.equal(wrapper.find('.p-path').text(), '/home/u/project/package.json');
  assert.equal(text.includes('{"kind"'), false);
});

test('правка файла показывается двухколоночным диффом', async (t) => {
  const { wrapper } = await mountPermission(t, {
    pid: 'p3',
    chatKey: 'c1',
    tool: 'Edit file',
    input: {
      kind: 'edit',
      description: 'Requesting approval to edit a file',
      file_path: 'server/src/app.js',
      diff: {
        old: 'const a = 1;\nconst b = 2;\n',
        new: 'const a = 1;\nconst b = 3;\n',
      },
    },
  });

  assert.equal(wrapper.find('.p-diff').exists(), true);
  assert.equal(wrapper.findAll('.dcell.del').length, 1);
  assert.equal(wrapper.findAll('.dcell.add').length, 1);
  assert.equal(wrapper.find('.dcell.del').text(), 'const b = 2;');
  assert.equal(wrapper.find('.dcell.add').text(), 'const b = 3;');
});

test('длинные варианты плана используют choice rows и сохраняют choice id', async (t) => {
  const { wrapper, flushPromises } = await mountPermission(t, {
    pid: 'p4',
    chatKey: 'c1',
    tool: 'Plan',
    input: {
      plan: 'Шаг 1. Изучить\nШаг 2. Починить',
      choices: [
        {
          id: 'plan_approve',
          label: 'Approve plan',
          kind: 'allow_once',
        },
        {
          id: 'plan_revise',
          label: 'Revise plan',
          kind: 'reject_once',
        },
      ],
    },
  });
  const choices = wrapper.findAll('.ui-choice-list__option');

  assert.deepEqual(choices.map((entry) => entry.text()), [
    'Approve plan',
    'Revise plan',
  ]);
  assert.match(wrapper.find('.p-in.big').text(), /Шаг 2\. Починить/);

  await choices[0].trigger('click');
  assert.deepEqual(
    wrapper.emitted('answer'),
    [[true, false, '', 'plan_approve']],
  );

  globalThis.__chatPermissionPrompt = async () => 'сначала тесты';
  await choices[1].trigger('click');
  await flushPromises();

  assert.deepEqual(
    wrapper.emitted('answer')[1],
    [false, false, 'сначала тесты', 'plan_revise'],
  );
});

test('незнакомая форма запроса не превращается в пустую карточку', async (t) => {
  const { wrapper } = await mountPermission(t, {
    pid: 'p5',
    chatKey: 'c1',
    tool: 'Странный инструмент',
    input: {
      whatever: 'значение',
    },
  });

  assert.match(wrapper.find('.p-in').text(), /whatever/);
});
