import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const STEP_LIST_PATH = webFile('src/views/chat/StepList.vue');
const ACTION_STYLES_PATH = webFile('src/styles/components/actions.css');

async function compileStepList() {
  return compileVue(STEP_LIST_PATH);
}

test('StepList раскрывает Bash-команду целиком, не ограничиваясь заголовком', async () => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/chats' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  const [{ mount }, StepList] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileStepList(),
  ]);
  const command = 'node --test very-long-test-name.js && printf "виден конец команды"';
  const wrapper = mount(StepList, {
    props: {
      live: true,
      steps: [{
        k: 'tool',
        name: 'Bash',
        title: 'node --test very-long-test-name.js…',
        command,
      }],
    },
  });

  assert.equal(wrapper.find('.body.command').exists(), false);
  assert.equal(wrapper.find('.ttl').attributes('title'), command);
  await wrapper.find('.head').trigger('click');
  assert.equal(wrapper.find('.body.command').text(), command);
});

test('StepList сохраняет полноширинную компактную строку внутри UiDisclosureButton', async () => {
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

test('StepList не схлопывает пункты обновлённого плана в одну строку', async () => {
  const component = await readFile(STEP_LIST_PATH, 'utf8');

  assert.match(component, /\.note\s*\{[^}]*white-space:\s*pre-line/s);
  assert.match(component, /\.note\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test('StepList не сдвигает служебную строку вдвое', async () => {
  const component = await readFile(STEP_LIST_PATH, 'utf8');

  // Внешний .step носит класс вида шага, поэтому общий селектор .note давал служебной
  // строке padding-left дважды: отметка повтора стояла правее соседних стартов.
  assert.match(component, /\.step\s*>\s*\.note\s*\{[^}]*padding:\s*2px 4px 2px 26px/s);
  assert.doesNotMatch(component, /^\.note\s*\{/m);
});
