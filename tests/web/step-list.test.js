import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const STEP_LIST_PATH = fileURLToPath(new URL('../../web/src/views/chat/StepList.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const DIFF_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/diff.js', import.meta.url),
)).href;

async function compileStepList() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(STEP_LIST_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: STEP_LIST_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, {
    id: 'data-v-step-list-test',
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace(
      "from '../../shared/diff.js'",
      `from "${DIFF_URL}"`,
    );

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return (await import(moduleUrl)).default;
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
