process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { STEP_IMAGE_TEXT } from '../../shared/chatSteps.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

const STEP_LIST_PATH = webFile('src/views/chat/StepList.vue');
const ACTION_STYLES_PATH = webFile('src/styles/components/actions.css');

let browser;
let StepList;
let mount;

before(async () => {
  browser = await createUiBrowser();
  StepList = await compileVue(STEP_LIST_PATH);
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
});

after(async () => {
  await browser.close();
});

/**
 * Все сценарии живут в одном документе, который запоминает Vue runtime.
 * Каждый mount прикреплён к DOM и обязательно размонтируется по завершении теста.
 */
async function mountStepList(t, steps, props = {}) {
  const wrapper = mount(StepList, {
    props: {
      live: true,
      steps,
      ...props,
    },
    attachTo: browser.document.querySelector('#mount'),
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

test('StepList раскрывает Bash-команду целиком, не ограничиваясь заголовком', async (t) => {
  const command = 'node --test very-long-test-name.js && printf "виден конец команды"';
  const wrapper = await mountStepList(t, [{
    k: 'tool',
    name: 'Bash',
    title: 'node --test very-long-test-name.js…',
    command,
  }]);

  assert.equal(wrapper.find('.body.command').exists(), false);
  assert.equal(wrapper.find('.ttl').attributes('title'), undefined);
  await wrapper.find('.head').trigger('click');
  assert.equal(wrapper.find('.body.command').text(), command);
});

test('StepList сохраняет полноширинную компактную строку внутри UiDisclosureButton', async (t) => {
  const [component, actions] = await Promise.all([
    readFile(STEP_LIST_PATH, 'utf8'),
    readFile(ACTION_STYLES_PATH, 'utf8'),
  ]);

  assert.match(
    actions,
    /\.ui-disclosure-button\s*>\s*\.ui-button__content\s*\{[^}]*width:\s*100%/s,
  );
  assert.match(
    actions,
    /\.ui-disclosure-button\s+\.ui-button__label\s*\{[^}]*display:\s*inline-flex/s,
  );
  assert.match(
    actions,
    /\.ui-disclosure-button--compact,[^{]*\{[^}]*min-height:\s*0[^}]*padding:\s*3px 4px/s,
  );
  assert.match(component, /density="compact"/);
  assert.match(component, /\.step-disclosure\s*\{[^}]*width:\s*100%/s);
});

test('StepList не схлопывает пункты обновлённого плана в одну строку', async (t) => {
  const component = await readFile(STEP_LIST_PATH, 'utf8');

  assert.match(component, /\.note\s*\{[^}]*white-space:\s*pre-line/s);
  assert.match(component, /\.note\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test('StepList обновляет строку вызова, а не заводит вторую', async (t) => {
  // Исполнитель досылает подробности того же вызова (растущий патч) отдельным шагом
  // с тем же id: две строки читались бы как два разных действия.
  const wrapper = await mountStepList(t, [
    { k: 'tool', id: 'fc-1', name: 'Edit', title: 'a.py', files: ['a.py'] },
    { k: 'tool', id: 'fc-1', name: 'Edit', title: '3 файлов', files: ['a.py', 'b.py', 'c.py'] },
    { k: 'res', id: 'fc-1', ok: true, text: '' },
  ]);

  const rows = wrapper.findAll('.step.tool');
  assert.equal(rows.length, 1);
  assert.equal(wrapper.find('.ttl').text(), '3 файлов');
  assert.equal(wrapper.find('.mark').text(), '✓');
});

test('StepList показывает итог, чей вызов вытеснен из ленты', async (t) => {
  // Окно ленты выбрасывает начало длинного хода вместе со строкой инструмента.
  // Осиротевший результат раньше рисовался пустой строкой без разметки.
  const wrapper = await mountStepList(t, [
    { k: 'res', id: 'ушедший-вызов', ok: false, text: 'exit code 1', lines: 1 },
  ]);

  const row = wrapper.find('.step.res');
  assert.equal(row.exists(), true);
  assert.match(row.text(), /Итог/);
  assert.equal(wrapper.find('.mark.bad').text(), '✕');
  await wrapper.find('.head').trigger('click');
  assert.equal(wrapper.find('.body.res').text(), 'exit code 1');
});

test('StepList рисует вложенным шаг субагента, а не правку с путём файла', async (t) => {
  const wrapper = await mountStepList(t, [
    { k: 'tool', id: 'edit-1', name: 'Edit', title: 'a.ts', sub: '/repo/src/a.ts', diff: { old: 'a', new: 'b' } },
    { k: 'tool', id: 'task-1', name: 'Task', title: 'подзадача', sub: 'general-purpose' },
    { k: 'tool', id: 'inner-1', name: 'Bash', title: 'ls', command: 'ls', parent: 'task-1' },
    // Сохранённая до разделения полей лента: вложенность ехала булевым sub.
    { k: 'tool', id: 'old-1', name: 'Bash', title: 'pwd', command: 'pwd', sub: true },
  ]);
  const rows = wrapper.findAll('.step');

  // `sub` с путём — подпись, а не вложенность: правка в корне хода стоит в общем ряду.
  assert.equal(rows[0].classes().includes('nested'), false, 'правка с путём файла нарисована вложенной');
  assert.equal(rows[1].classes().includes('nested'), false, 'вызов Task нарисован вложенным');
  assert.equal(rows[2].classes().includes('nested'), true, 'шаг субагента не нарисован вложенным');
  assert.equal(rows[3].classes().includes('nested'), true, 'старая лента потеряла вложенность');

  // В раскрытии булев признак путём не показывается.
  await rows[3].find('button').trigger('click');
  assert.equal(rows[3].find('.path').exists(), false, 'булев sub показан как путь «true»');
  await rows[0].find('button').trigger('click');
  assert.equal(rows[0].find('.path').text(), '/repo/src/a.ts');
});

test('StepList не сдвигает служебную строку вдвое', async (t) => {
  const component = await readFile(STEP_LIST_PATH, 'utf8');

  // Внешний .step носит класс вида шага, поэтому общий селектор .note давал служебной
  // строке padding-left дважды: отметка повтора стояла правее соседних стартов.
  assert.match(component, /\.step\s*>\s*\.note\s*\{[^}]*padding:\s*2px 4px 2px 26px/s);
  assert.doesNotMatch(component, /^\.note\s*\{/m);
});

/**
 * Строка Read с растром и успешным итогом — тот случай, ради которого лента показывает
 * картинку. Путь лежит в рабочей папке чата, итог несёт общую заглушку нормализатора.
 */
function imageRead(res = {}, tool = {}) {
  return [
    {
      k: 'tool',
      id: 'read-1',
      name: 'Read',
      title: 'shot.png',
      sub: '/repo/.state/artifacts/shot.png',
      ...tool,
    },
    {
      k: 'res',
      id: 'read-1',
      ok: true,
      text: STEP_IMAGE_TEXT,
      ...res,
    },
  ];
}

test('StepList не вешает справку на строку действия', async () => {
  const component = await readFile(STEP_LIST_PATH, 'utf8');

  assert.doesNotMatch(component, /<UiTooltip|v-tooltip/);
});

test('StepList показывает рассмотренную картинку через маршрут рабочей папки чата', async (t) => {
  const wrapper = await mountStepList(t, imageRead(), { chatId: 'chat 1' });

  assert.equal(wrapper.find('.step-image').exists(), false);
  await wrapper.get('.step-disclosure').trigger('click');

  const src = '/api/chat/chat%201/image?path=%2Frepo%2F.state%2Fartifacts%2Fshot.png';

  assert.equal(wrapper.get('.step-image img').attributes('src'), src);
  assert.equal(wrapper.get('.step-image img').attributes('alt'), 'shot.png');
  assert.equal(wrapper.get('.step-image').attributes('href'), src);
  assert.equal(wrapper.find('.body.res').exists(), false, 'рядом с картинкой осталась заглушка');
  assert.equal(wrapper.get('.path').text(), '/repo/.state/artifacts/shot.png');
});

test('StepList показывает картинку только у Read с успешным итогом в чате', async (t) => {
  const cases = [
    ['без итога', imageRead().slice(0, 1)],
    ['итог с ошибкой', imageRead({ ok: false, text: 'File does not exist.' })],
    ['без чата', imageRead(), ''],
    ['не Read', imageRead({}, { name: 'Write' })],
  ];

  for (const [name, steps, chatId = 'c1'] of cases) {
    const wrapper = await mountStepList(t, steps, { chatId });

    await wrapper.get('.step-disclosure').trigger('click');
    assert.equal(wrapper.find('.step-image').exists(), false, name);
    assert.equal(wrapper.find('.step-image-missing').exists(), false, name);
  }
});

test('StepList заменяет неотданную картинку честной подписью', async (t) => {
  const wrapper = await mountStepList(t, imageRead(), { chatId: 'c1' });

  await wrapper.get('.step-disclosure').trigger('click');
  await wrapper.get('.step-image img').trigger('error');
  assert.equal(wrapper.find('.step-image').exists(), false);
  assert.equal(wrapper.get('.step-image-missing').text(), 'Изображение недоступно');
  assert.equal(wrapper.find('.body.res').exists(), false);
});
