process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { MARKDOWN_STUBS } from './helpers/rich-markdown.js';
import { createUiBrowser } from './helpers/ui-components.js';

const STEP_LIST_PATH = webFile('src/views/chat/StepList.vue');
const ACTION_STYLES_PATH = webFile('src/styles/components/actions.css');

let browser;
let StepList;
let mount;
let nextTick;
let highlightCalls;

before(async () => {
  browser = await createUiBrowser();
  StepList = await compileVue(STEP_LIST_PATH, { stubs: MARKDOWN_STUBS });
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
  ({ nextTick } = await import('../../web/node_modules/vue/index.mjs'));
});

beforeEach(() => {
  highlightCalls = [];
  globalThis.__mdHighlight = async (...args) => {
    highlightCalls.push(args);

    return null;
  };
});

after(async () => {
  delete globalThis.__mdHighlight;
  await browser.close();
});

/**
 * Все сценарии живут в одном документе, который запоминает Vue runtime.
 * Каждый mount прикреплён к DOM и обязательно размонтируется по завершении теста.
 */
async function mountStepList(t, steps) {
  const wrapper = mount(StepList, {
    props: { live: true, steps },
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

const tipCommand = "cd /srv/app && rg -n 'TODO' src | head -20; echo ---; sed -n 1,80p src/main.ts | cat";
const tipFormatted = [
  'cd /srv/app &&',
  "  rg -n 'TODO' src |",
  '  head -20',
  'echo ---',
  'sed -n 1,80p src/main.ts |',
  '  cat',
].join('\n');

async function hoverStep(wrapper) {
  await wrapper.get('.step-disclosure').trigger('pointerenter', { pointerType: 'mouse' });
  await new Promise((resolve) => setTimeout(resolve, 320));
  await nextTick();
}

function currentTip() {
  return browser.document.querySelector('.ui-tooltip');
}

test('TIP-LIST-01: живая лента не форматирует и не подсвечивает до открытия', async (t) => {
  const row = {
    k: 'tool',
    name: 'Bash',
    command: tipCommand,
    title: 'Команда',
  };
  const wrapper = await mountStepList(t, [row]);

  assert.equal(wrapper.get('.ttl').attributes('title'), undefined);
  assert.equal(Boolean(currentTip()), false);
  assert.equal(highlightCalls.length, 0);
  await wrapper.setProps({ steps: [row, { k: 'note', text: 'Продолжение' }] });
  assert.equal(highlightCalls.length, 0);
});

test('TIP-LIST-02: наведение показывает формат и вызывает подсветку', async (t) => {
  const wrapper = await mountStepList(t, [{
    k: 'tool',
    name: 'Bash',
    command: tipCommand,
    title: 'Команда',
  }]);

  await hoverStep(wrapper);
  assert.equal(Boolean(currentTip()?.classList.contains('ui-tooltip--code')), true);
  assert.equal(currentTip()?.querySelector('pre')?.textContent, tipFormatted);
  assert.deepEqual(highlightCalls, [[tipFormatted, 'bash']]);
});

test('TIP-LIST-03: preview исполнителя, путь Read и заголовок Task', async (t) => {
  for (const [row, expected] of [
    [{
    name: 'Bash',
    preview: tipCommand,
    lang: 'bash',
  }, tipFormatted],
    [{
    name: 'Read',
    sub: '/full/file.ts',
    title: 'file.ts',
  }, '/full/file.ts'],
    [{
    name: 'Task',
    sub: 'Explore',
    title: 'Изучить код',
  }, 'Изучить код'],
  ]) {
    const wrapper = await mountStepList(t, [{ k: 'tool', ...row }]);

    await hoverStep(wrapper);
    assert.equal(currentTip()?.querySelector('pre')?.textContent, expected);
    wrapper.unmount();
  }
});

test('TIP-LIST-04: нажатие прячет справку, раскрытие сохраняет исходник', async (t) => {
  for (const field of ['command', 'preview']) {
    const wrapper = await mountStepList(t, [{
      k: 'tool',
      name: 'Bash',
      title: 'Команда',
      lang: 'bash',
      [field]: tipCommand,
    }]);

    await hoverStep(wrapper);
    await wrapper.get('.step-disclosure').trigger('pointerdown', { pointerType: 'mouse' });
    assert.equal(Boolean(currentTip()), false);
    await wrapper.get('.step-disclosure').trigger('click');
    assert.equal(wrapper.get(field === 'command' ? 'pre.command' : '.body-wrap pre').text(), tipCommand);
    wrapper.unmount();
  }
});

test('TIP-LIST-05: Tab описывает кнопку, касание не показывает', async (t) => {
  const wrapper = await mountStepList(t, [{
    k: 'tool',
    name: 'Bash',
    command: 'echo ok',
    title: 'echo',
  }]);
  const button = wrapper.get('.step-disclosure');

  await button.trigger('pointerenter', { pointerType: 'touch' });
  await new Promise((resolve) => setTimeout(resolve, 320));
  await nextTick();
  assert.equal(Boolean(currentTip()), false);
  button.element.focus();
  await new Promise((resolve) => setTimeout(resolve, 320));
  await nextTick();
  assert.equal(currentTip()?.id, button.attributes('aria-describedby'));
  assert.equal(currentTip()?.querySelector('pre')?.textContent, 'echo ok');
});

test('TIP-LIST-06: пустой шаг не создаёт справку', async (t) => {
  const wrapper = await mountStepList(t, [{ k: 'tool', name: 'Bash' }]);

  assert.equal(wrapper.get('.step-disclosure').attributes('aria-describedby'), undefined);
  await hoverStep(wrapper);
  assert.equal(Boolean(currentTip()), false);
  assert.equal(highlightCalls.length, 0);
});
