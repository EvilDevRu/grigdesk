// Блок «О чём ролик»: черновик принадлежит человеку.
//
// Проверяется то, что легко потерять между ответами сервера: введённое пожелание и
// галочки переживают ответ списка и его обновление, чужая правка выбора не затирает
// тронутый черновик, сохранённый выбор вне видимого списка виден и снимается, а переход
// от умолчания к явным отметкам при скрытой истории спрашивает человека.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const PANEL = webFile('src/views/showcase/ShowcaseSourcePanel.vue');

const UI_STUB = `
export { default as UiLoadingState } from './src/components/feedback/UiLoadingState.vue';
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiCheckbox } from '${webFile('src/components/primitives/UiCheckbox.vue')}';
export { default as UiSpinner } from '${webFile('src/components/primitives/UiSpinner.vue')}';
export { default as UiTextarea } from '${webFile('src/components/primitives/UiTextarea.vue')}';
export { default as UiField } from '${webFile('src/components/composites/UiField.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export const confirmDialog = async (text, options) => {
  globalThis.__showcaseSourceHarness.confirmations.push({ text, options });
  return globalThis.__showcaseSourceHarness.confirmed;
};
export { vTooltip } from "./src/services/tooltipDirective.ts";
`;

const NEW = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const DEEP = 'c'.repeat(40);
const GONE = 'd'.repeat(40);

let compiledPanel = null;

function panelComponent() {
  compiledPanel ??= compileVue(PANEL, { stubs: { '../../ui': UI_STUB } });

  return compiledPanel;
}

function commit(id, subject) {
  return {
    id,
    subject,
    date: '2026-10-08T10:00:00+07:00',
    own: true,
    merge: false,
  };
}

/**
 * Список выбора песочницы: два своих коммита и незакоммиченное. Тест дописывает в него
 * просьбу подтвердить сужение и выбор вне видимого списка.
 */
function options(overrides = {}) {
  return {
    taskAvailable: true,
    noteMax: 2000,
    defaults: {
      task: true,
      note: '',
      code: true,
      repos: [{
        name: 'frontend',
        work: true,
        commits: [NEW, OLD],
      }],
    },
    requiresExplicitSelectionConfirmation: false,
    selectedOutsideCatalog: [],
    repos: [{
      name: 'frontend',
      branch: 'route-task-1',
      workFiles: 2,
      commits: [commit(NEW, 'Диалог съёма'), commit(OLD, 'Фильтры доски')],
      error: null,
    }],
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: 'project-1',
    revision: 3,
    ref: { kind: 'sandbox', id: '990001' },
    target: { status: 'ready' },
    scenes: [],
    source: null,
    ...overrides,
  };
}

function choice(overrides = {}) {
  return {
    task: true,
    note: '',
    code: true,
    repos: null,
    ...overrides,
  };
}

/**
 * Блок монтируется один, с настоящими контролами: свойства меняет тест через setProps,
 * а применение записывается так же, как его получил бы вид.
 */
async function mountPanel(t, props = {}, { confirmed = true } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/showcase');
  const harness = {
    confirmed,
    confirmations: [],
    applied: [],
    reloads: 0,
  };

  globalThis.__showcaseSourceHarness = harness;

  const Component = await panelComponent();
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      project: project(),
      options: options(),
      loading: false,
      error: '',
      busy: false,
      onApply: (source) => harness.applied.push(source),
      onReload: () => {
        harness.reloads += 1;
      },
      ...props,
    },
  });

  t.after(() => {
    wrapper.unmount();

    if (globalThis.__showcaseSourceHarness === harness) {
      delete globalThis.__showcaseSourceHarness;
    }
  });

  await flushPromises();

  return {
    wrapper,
    harness,
    flushPromises,
  };
}

function buttonByText(wrapper, text) {
  return wrapper.findAll('button').find((button) => button.text().includes(text));
}

async function apply(wrapper, flushPromises) {
  await wrapper.find('[data-testid="showcase-source-apply"]').trigger('click');
  await flushPromises();
}

test('пожелание, набранное до ответа списка, переживает и ответ, и обновление списка', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t, { options: null, loading: true });

  await wrapper.find('[data-testid="showcase-source-note"]').setValue('Упор на фильтры');
  await wrapper.setProps({ options: options(), loading: false });
  await wrapper.setProps({ options: options() });
  await flushPromises();

  assert.equal(wrapper.find('[data-testid="showcase-source-note"]').element.value, 'Упор на фильтры');
  assert.equal(wrapper.find('[data-testid="showcase-source-task"]').element.checked, true);

  await apply(wrapper, flushPromises);

  assert.deepEqual(harness.applied, [choice({ note: 'Упор на фильтры' })]);
});

test('свой сохранённый выбор принимается, а чужая правка не затирает тронутый черновик', async (t) => {
  const saved = choice({ note: 'Сохранённый упор' });
  const { wrapper, harness, flushPromises } = await mountPanel(t, { project: project({ source: saved }) });
  const note = () => wrapper.find('[data-testid="showcase-source-note"]').element.value;

  await wrapper.setProps({ project: project({ source: choice({ note: 'Из другой вкладки' }) }) });
  await flushPromises();

  assert.equal(note(), 'Из другой вкладки', 'нетронутый черновик следует за сохранённым');

  await wrapper.find('[data-testid="showcase-source-note"]').setValue('Мой упор');
  await wrapper.setProps({ project: project({ source: choice({ note: 'Снова чужой' }) }) });
  await flushPromises();

  assert.equal(note(), 'Мой упор', 'тронутый черновик остаётся у человека');
  assert.equal(wrapper.find('[data-role="source-external"]').exists(), true);

  await buttonByText(wrapper, 'Вернуть сохранённый').trigger('click');
  await flushPromises();

  assert.equal(note(), 'Снова чужой');
  assert.equal(wrapper.find('[data-role="source-external"]').exists(), false);

  await wrapper.find('[data-testid="showcase-source-note"]').setValue('Окончательный');
  await apply(wrapper, flushPromises);
  await wrapper.setProps({ project: project({ source: harness.applied.at(-1) }) });
  await flushPromises();

  assert.equal(note(), 'Окончательный', 'свой сохранённый выбор принят каноническим');
  assert.equal(wrapper.find('[data-role="source-external"]').exists(), false);
});

test('«Коммиты по умолчанию» возвращает только выбор коммитов, пожелание остаётся', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t);

  await wrapper.find('[data-testid="showcase-source-note"]').setValue('Только диалог');
  await wrapper.find(`[data-testid="showcase-source-commit-${OLD.slice(0, 7)}"]`).setValue(false);
  await flushPromises();
  await buttonByText(wrapper, 'Коммиты по умолчанию').trigger('click');
  await apply(wrapper, flushPromises);

  assert.deepEqual(harness.applied, [choice({ note: 'Только диалог' })]);
});

test('сохранённый выбор вне списка и пропавший репозиторий видны и снимаются', async (t) => {
  const saved = choice({
    repos: [
      {
        name: 'frontend',
        work: true,
        commits: [NEW, DEEP, GONE],
      },
      {
        name: 'пропавший',
        work: true,
        commits: [],
      },
    ],
  });
  const outside = [
    {
      name: 'frontend',
      missing: false,
      commits: [
        {
          id: DEEP,
          subject: 'Старая работа',
          state: 'available',
        },
        {
          id: GONE,
          subject: null,
          state: 'outdated',
        },
      ],
    },
    {
      name: 'пропавший',
      missing: true,
      commits: [],
    },
  ];
  const { wrapper, harness, flushPromises } = await mountPanel(t, {
    project: project({ source: saved }),
    options: options({ selectedOutsideCatalog: outside }),
  });

  assert.match(wrapper.text(), /Старая работа/);
  assert.match(wrapper.text(), /пропал из истории/);
  assert.equal(wrapper.find('[data-role="source-missing"]').exists(), true);

  await wrapper.find(`[data-testid="showcase-source-outside-${GONE.slice(0, 7)}"]`).setValue(false);
  await buttonByText(wrapper, 'Убрать из выбора').trigger('click');
  await flushPromises();
  await apply(wrapper, flushPromises);

  const [applied] = harness.applied;

  assert.deepEqual(applied.repos.map((repo) => repo.name), ['frontend'], 'пропавший репозиторий снят');
  assert.deepEqual([...applied.repos[0].commits].sort(), [NEW, DEEP].sort());
});

test('несохранённый коммит черновика, выпавший из обновлённого списка, остаётся видимым', async (t) => {
  const { wrapper, flushPromises } = await mountPanel(t, {
    project: project({
      source: choice({
        repos: [{
          name: 'frontend',
          work: false,
          commits: [OLD],
        }],
      }),
    }),
  });

  await wrapper.find(`[data-testid="showcase-source-commit-${NEW.slice(0, 7)}"]`).setValue(true);
  await wrapper.setProps({
    options: options({
      repos: [{
        ...options().repos[0],
        commits: [commit(OLD, 'Фильтры доски')],
      }],
    }),
  });
  await flushPromises();

  assert.equal(wrapper.find(`[data-testid="showcase-source-outside-${NEW.slice(0, 7)}"]`).exists(), true);
  assert.match(wrapper.text(), /будет проверен при применении/);
});

test('сужение умолчания при скрытой истории спрашивает, а отказ оставляет умолчание', async (t) => {
  const declined = await mountPanel(t, {
    options: options({ requiresExplicitSelectionConfirmation: true }),
  }, { confirmed: false });
  const box = () => declined.wrapper.find(`[data-testid="showcase-source-commit-${OLD.slice(0, 7)}"]`);

  await box().setValue(false);
  await declined.flushPromises();

  assert.equal(declined.harness.confirmations.length, 1);
  assert.equal(declined.harness.confirmations[0].options.title, 'Сузить выбор');
  assert.equal(box().element.checked, true, 'галочка вернулась к умолчанию');

  await apply(declined.wrapper, declined.flushPromises);

  assert.deepEqual(declined.harness.applied, [null], 'отказ оставил умолчание ветки');

  const accepted = await mountPanel(t, {
    options: options({ requiresExplicitSelectionConfirmation: true }),
  });

  await accepted.wrapper.find(`[data-testid="showcase-source-commit-${OLD.slice(0, 7)}"]`).setValue(false);
  await accepted.flushPromises();
  await apply(accepted.wrapper, accepted.flushPromises);

  assert.deepEqual(accepted.harness.applied[0].repos, [{
    name: 'frontend',
    work: true,
    commits: [NEW],
  }]);
});

test('правка пожелания и кода не сужает умолчание и подтверждения не просит', async (t) => {
  const { wrapper, harness, flushPromises } = await mountPanel(t, {
    options: options({ requiresExplicitSelectionConfirmation: true }),
  });

  await wrapper.find('[data-testid="showcase-source-note"]').setValue('Упор на запуск');
  await wrapper.find('[data-testid="showcase-source-code"]').setValue(false);
  await apply(wrapper, flushPromises);

  assert.equal(harness.confirmations.length, 0);
  assert.deepEqual(harness.applied, [choice({ note: 'Упор на запуск', code: false })]);
});

test('недоступный стенд не даёт применить выбор и называет причину', async (t) => {
  const { wrapper } = await mountPanel(t, {
    project: project({ target: { status: 'blocked' } }),
  });

  assert.equal(wrapper.find('[data-testid="showcase-source-apply"]').attributes('disabled'), '');
  assert.match(wrapper.text(), /Стенд недоступен/);
});

test('отметки нечитаемого репозитория видны и снимаются без потери остальных', async (t) => {
  const saved = choice({
    repos: [
      {
        name: 'frontend',
        work: true,
        commits: [OLD],
      },
      {
        name: 'backend',
        work: false,
        commits: [NEW],
      },
    ],
  });
  const catalog = options({
    repos: [
      {
        ...options().repos[0],
        workFiles: 0,
        commits: [],
        error: 'История не читается.',
      },
      { ...options().repos[0], name: 'backend' },
    ],
    selectedOutsideCatalog: [{
      name: 'frontend',
      missing: false,
      commits: [{
        id: OLD,
        subject: null,
        state: 'unavailable',
      }],
    }],
  });
  const { wrapper, harness, flushPromises } = await mountPanel(t, {
    project: project({ source: saved }),
    options: catalog,
  });
  const outside = `[data-testid="showcase-source-outside-${OLD.slice(0, 7)}"]`;

  assert.equal(wrapper.find(outside).exists(), true, 'выбранный коммит виден при ошибке истории');
  await wrapper.find(outside).setValue(false);
  await wrapper.find('[data-testid="showcase-source-work-frontend"]').setValue(false);
  await apply(wrapper, flushPromises);

  assert.deepEqual(harness.applied[0].repos, [saved.repos[1]]);
});

test('выбранное незакоммиченное можно снять и после появления чистого дерева', async (t) => {
  const saved = choice({
    repos: [{
      name: 'frontend',
      work: true,
      commits: [OLD],
    }],
  });
  const { wrapper, harness, flushPromises } = await mountPanel(t, {
    project: project({ source: saved }),
    options: options({ repos: [{ ...options().repos[0], workFiles: 0 }] }),
  });
  const work = wrapper.find('[data-testid="showcase-source-work-frontend"]');

  assert.equal(work.element.disabled, false);
  await work.setValue(false);
  await apply(wrapper, flushPromises);

  assert.deepEqual(harness.applied[0].repos, [{
    name: 'frontend',
    work: false,
    commits: [OLD],
  }]);
});

test('подтверждение сужения прежнего ролика не меняет черновик нового', async (t) => {
  let accept;
  const confirmed = new Promise((resolve) => {
    accept = resolve;
  });
  const { wrapper, harness, flushPromises } = await mountPanel(t, {
    options: options({ requiresExplicitSelectionConfirmation: true }),
  }, { confirmed });

  await wrapper.find(`[data-testid="showcase-source-commit-${OLD.slice(0, 7)}"]`).setValue(false);
  await wrapper.setProps({ project: project({ id: 'project-2' }) });
  accept(true);
  await flushPromises();
  await apply(wrapper, flushPromises);

  assert.equal(harness.confirmations.length, 1);
  assert.deepEqual(harness.applied, [null], 'новый ролик сохраняет своё нетронутое умолчание');
});
