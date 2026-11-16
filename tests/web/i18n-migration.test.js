import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

let modulePromise;

/**
 * Компоненты и чистые помощники используют один настоящий источник языка.
 * Смена локали проверяется на уже созданных объектах, без повторного импорта.
 */
async function migration(t) {
  const browser = await installUiBrowser(t);

  modulePromise ||= compileModule(webFile('../tests/web/helpers/i18nMigration.ts'));

  const module = await modulePromise;

  module.connectUiLocalePort(module.uiLocale);
  module.setUiLocale('ru');
  t.after(() => module.setUiLocale('ru'));

  return { browser, module };
}

test('I18N-MIG: таблицы и Markdown меняют язык без пересоздания', async (t) => {
  const { module } = await migration(t);
  const states = module.SANDBOX_STATES;
  const state = states[0];
  const words = module.THINKING_WORDS;
  const source = '> [!NOTE]\n> Пользовательский текст core.board';

  assert.equal(state.label, 'Все стенды');
  assert.equal(module.continuationLabel(), '↳ продолжает предыдущую');
  assert.equal(words[0], 'Думаю');
  assert.match(module.mdToHtml(source), /Заметка/);

  module.setUiLocale('en');

  assert.equal(module.SANDBOX_STATES, states);
  assert.equal(states[0], state);
  assert.equal(state.value, 'all');
  assert.equal(state.label, 'All environments');
  assert.equal(words[0], 'Thinking');
  assert.equal(module.thinkingWord([{
    k: 'tool',
    id: 'x',
    name: 'Bash',
  }], 0), 'Running a command');
  assert.doesNotMatch(module.continuationLabel(), /[А-Яа-яЁё]/u);
  assert.match(module.mdToHtml(source), /Note/);
  assert.match(module.mdToHtml(source), /Пользовательский текст core\.board/);

  module.setUiLocale('ru');

  assert.equal(state.label, 'Все стенды');
  assert.equal(words[0], 'Думаю');
});

test('I18N-MIG: английский дифф распознаёт исходный серверный маркер', async (t) => {
  const { module } = await migration(t);
  const patch = '@@ -1,2 +1,2 @@\n-old\n… сокращено …\n+new';

  module.setUiLocale('en');

  const diff = module.unifiedDiff(patch);

  assert.deepEqual(diff, {
    rows: [
      { t: 'del', text: 'old' },
      { t: 'ctx', text: '… truncated …' },
      { t: 'add', text: 'new' },
    ],
    added: 1,
    removed: 1,
  });
});

test('I18N-MIG: смонтированные controls и строка хода переключаются RU → EN → RU', async (t) => {
  const { browser, module } = await migration(t);
  const [{ mount }, { nextTick }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const wrappers = [
    mount(module.UiAudio, { props: { src: '/audio' } }),
    mount(module.UiVideo, { props: { src: '/video' } }),
    mount(module.ChatThinking, {
      attachTo: browser.document.querySelector('#mount'),
      props: {
        steps: [{
          k: 'tool',
          id: 'x',
          name: 'Bash',
        }],
        tokens: 1500,
      },
    }),
    mount(module.TriageBadge),
  ];

  t.after(() => wrappers.forEach((wrapper) => wrapper.unmount()));
  assert.match(wrappers[2].text(), /Выполняю команду/);
  assert.equal(wrappers[0].attributes('aria-label'), 'Звук сцены');
  assert.equal(wrappers[3].text(), 'Без оценки');

  module.setUiLocale('en');
  await nextTick();

  assert.doesNotMatch(wrappers[0].attributes('aria-label'), /[А-Яа-яЁё]/u);
  assert.doesNotMatch(wrappers[1].attributes('aria-label'), /[А-Яа-яЁё]/u);
  assert.match(wrappers[2].text(), /Running a command/);
  assert.doesNotMatch(wrappers[3].text(), /[А-Яа-яЁё]/u);

  module.setUiLocale('ru');
  await nextTick();

  assert.match(wrappers[2].text(), /Выполняю команду/);
  assert.equal(wrappers[0].attributes('aria-label'), 'Звук сцены');
  assert.equal(wrappers[3].text(), 'Без оценки');
});
