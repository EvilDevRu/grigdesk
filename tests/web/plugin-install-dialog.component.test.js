import assert from 'node:assert/strict';
import { test, after } from 'node:test';

import { createUiBrowser } from './helpers/ui-components.js';
import { compileVue, webFile, singletonUrl } from './helpers/compile-vue.js';
import { pluginInstallUiDouble } from './helpers/pluginInstallUiFixture.js';
import { webInstallJob, webInstallInfo } from './helpers/pluginInstallFixtures.js';
import { moduleWarning } from '../server/helpers/pluginModuleFixture.js';

process.env.NODE_ENV = 'test';

const browser = await createUiBrowser('https://grigdesk.test/#/settings');
const { reactive, nextTick } = await import(singletonUrl('vue'));
const { mount, flushPromises } = await import(
  '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
);
const Dialog = await compileVue(webFile('src/views/settings/PluginInstallDialog.vue'), {
  stubs: {
    '../../stores/pluginCatalog.ts': 'export const usePluginCatalogStore = () => globalThis.__catalogUi;',
    '../../stores/pluginInstall.ts': 'export const usePluginInstallStore = () => globalThis.__installUi;',
  },
});

after(() => browser.close());

/**
 * Каждый сценарий монтирует свежий dialog с отдельным reactive store double.
 * Document остаётся один для Vue runtime, Teleport stub не меняет реальные primitives.
 */
async function mountInstallDialog(t, state = {}, props = {}, configure = () => {}) {
  const fixture = pluginInstallUiDouble(reactive, state);

  configure(fixture);
  globalThis.__installUi = fixture.state;
  globalThis.__catalogUi = reactive({
    index: null,
    state: 'unavailable',
    loading: false,
    loadIndex: async () => {},
  });

  const wrapper = mount(Dialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      open: true,
      mode: 'install',
      plugin: null,
      ...props,
    },
    global: { stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__installUi;
    delete globalThis.__catalogUi;
  });
  await flushPromises();

  return { ...fixture, wrapper };
}

test('D1: open читает job, пустой URL запрещает find; source/content dialog', async (t) => {
  const { wrapper, calls } = await mountInstallDialog(t);

  assert.equal(calls.filter(([method]) => method === 'loadJob').length, 1);
  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'source');
  assert.equal(wrapper.get('.ui-dialog-overlay').attributes('data-size'), 'content');
  assert.equal(wrapper.get('[data-role="install-find"]').element.disabled, true);
  assert.equal(wrapper.get('[data-role="install-url"]').element.value, '');
});

test('D2: find текущего URL выбирает первую версию; canonical URL допустим, смена сбрасывает', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t);
  const input = ' https://EXAMPLE.invalid/demo.git/ ';

  state.listVersions = async (url) => {
    calls.push(['listVersions', [url]]);
    state.versionsInputKey = url.trim();
    state.versionsUrl = 'https://example.invalid/demo.git';
    state.versions = [{
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: 'a'.repeat(40),
    }];
  };
  await wrapper.get('[data-role="install-url"]').setValue(input);
  await wrapper.get('[data-role="install-find"]').trigger('click');
  await flushPromises();
  assert.equal(calls.filter(([method]) => method === 'listVersions').length, 1);
  assert.deepEqual(calls.find(([method]) => method === 'listVersions')[1], [input]);
  assert.equal(wrapper.get('[data-role="install-version"]').element.value, '1.1.0');
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, false);
  assert.match(wrapper.text(), /v1\.1\.0/u);
  await wrapper.get('[data-role="install-url"]').setValue('https://other.invalid/demo.git');
  assert.equal(wrapper.get('[data-role="install-version"]').element.value, '');
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, true);
});

test('D3: start выбранной версии/force, bind дополнительно передаёт expectedId', async (t) => {
  const plugin = {
    id: 'demo',
    name: 'Ручной демо',
    system: false,
  };

  for (const bound of [false, true]) {
    const { wrapper, state, calls } = await mountInstallDialog(t, {}, { plugin: bound ? plugin : null });

    await wrapper.get('[data-role="install-url"]').setValue('file:///fixture.git');
    state.versionsInputKey = 'file:///fixture.git';
    state.versionsUrl = 'file:///fixture.git';
    state.versions = [{
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: 'a'.repeat(40),
    }];
    await nextTick();
    await wrapper.get('[data-role="install-version"]').setValue('1.1.0');
    await wrapper.get('[data-role="install-start"]').trigger('click');
    assert.equal(calls.filter(([method]) => method === 'startInstall').length, 1);
    assert.deepEqual(calls.find(([method]) => method === 'startInstall')[1], bound
      ? ['file:///fixture.git', '1.1.0', false, 'demo']
      : ['file:///fixture.git', '1.1.0', false]);
    wrapper.unmount();
  }
});

test('D4: fetching40 показывает progress и точные states трёх шагов', async (t) => {
  const job = webInstallJob('running', 'install', { percent: 40 });
  const { wrapper } = await mountInstallDialog(t, { job });

  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'progress');
  assert.equal(wrapper.get('[data-role="install-progress"]').attributes('aria-valuenow'), '40');
  assert.equal(wrapper.get('[data-role="install-progress"]').attributes('aria-label'), 'Ход установки');
  assert.deepEqual(wrapper.findAll('[data-role="install-stages"] li').map((row) => [
    row.attributes('data-stage'), row.attributes('data-state'),
  ]), [['fetching', 'current'], ['validating', 'pending'], ['dependencies', 'pending']]);
  assert.equal(wrapper.find('[data-role="install-url"]').exists(), false);
});

test('D5: dependencies indeterminate, явный cancel; applying не позволяет отмену', async (t) => {
  const job = webInstallJob('running', 'update', { stage: 'dependencies', percent: null });
  const { wrapper, state, calls } = await mountInstallDialog(t, { job });

  assert.equal(wrapper.get('[data-role="install-progress"]').attributes('aria-valuenow'), undefined);
  assert.equal(wrapper.find('[data-role="install-cancel"]').exists(), true);
  await wrapper.get('[data-role="install-cancel"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'cancel').length, 1);
  state.job = webInstallJob('applying', 'update');
  await nextTick();
  assert.equal(wrapper.find('[data-role="install-cancel"]').exists(), false);
  assert.match(wrapper.text(), /Применяем изменения/u);
});

test('D6: ready показывает полный preview/diff/warnings и явное apply', async (t) => {
  const job = webInstallJob();

  job.preview.replaces = {
    kind: 'managed',
    version: '0.9.0',
    sourceChanged: true,
  };
  job.preview.warnings = [moduleWarning];
  job.preview.changes = {
    commits: [{ sha: 'c'.repeat(40), subject: 'Изменение фикстуры' }],
    files: ['ui/panel.css', 'ui/ru.json', 'web/index.html'].map((path) => ({ status: 'M', path })),
    sensitive: ['ui/panel.css', 'ui/ru.json'],
    truncated: true,
  };

  const { wrapper, calls } = await mountInstallDialog(t, { job });

  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'ready');
  assert.equal(wrapper.find('[data-role="install-preview"]').exists(), true);

  assert.equal(wrapper.find('[data-role="install-file"]').exists(), false);
  assert.match(wrapper.get('[data-role="install-preview"]').text(),
    /код, исполняемый GrigDesk, или его зависимости/u);
  await wrapper.get('[data-role="install-changes-toggle"]').trigger('click');

  const text = wrapper.get('[data-role="install-preview"]').text();

  const previewValues = [
    'Демо', 'demo', 'v1.0.0', 'git', job.source.url, job.target.sha, 'Источник сменится.',
  ];

  for (const value of previewValues) {
    assert.equal(text.includes(value), true, value);
  }

  assert.equal(wrapper.findAll('[data-role="install-warning"]').length, 1);
  assert.match(wrapper.get('[data-role="install-commit"]').text(), /ccccccc.*Изменение фикстуры/u);

  const sensitive = wrapper.findAll('[data-role="install-file"]')
    .map((file) => file.attributes('data-sensitive'));

  assert.deepEqual(sensitive, ['true', 'true', 'false']);
  assert.equal(wrapper.get('[data-role="install-warning"]').text(), moduleWarning);
  assert.match(text, /код, исполняемый GrigDesk, или его зависимости/u);
  assert.match(text, /Список сокращён/u);
  assert.match(text, /Код плагина выполняется внутри GrigDesk с его правами/u);
  assert.equal(wrapper.get('[data-role="install-apply"]').text(), 'Установить из этого источника');
  await wrapper.get('[data-role="install-apply"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'apply').length, 1);
});

test('D7: явный ready cancel; закрытие running/ready не отменяет задание', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t, { job: webInstallJob() });

  assert.equal(wrapper.find('[data-role="install-cancel"]').exists(), true);
  await wrapper.get('[data-role="install-cancel"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'cancel').length, 1);

  for (const status of ['running', 'ready']) {
    state.job = webInstallJob(status);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    assert.equal(calls.filter(([method]) => method === 'cancel').length, 1);
    assert.equal(calls.filter(([method]) => method === 'forgetJob').length, 0);
    assert.equal(state.job.status, status);
  }
});

test('D8: done managed и rollback показывают различимый итог и перезапуск', async (t) => {
  const job = webInstallJob('done', 'update');

  job.preview.replaces = {
    kind: 'managed',
    version: '0.9.0',
    sourceChanged: false,
  };

  const { wrapper, state } = await mountInstallDialog(t, { job });

  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'result');
  assert.match(wrapper.get('[data-role="install-result"]').text(),
    /обновлён до v1\.0\.0.*Перезапустите GrigDesk и перезагрузите окно/u);
  state.job = webInstallJob('done', 'rollback');
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-result"]').text(),
    'Версия v1.0.0 восстановлена. Перезапустите GrigDesk и перезагрузите окно.');
  assert.equal(wrapper.find('[data-role="install-close"]').exists(), true);
});

test('D9: failed причина/retry forget, recovery_required нельзя забыть или начать поверх', async (t) => {
  const failed = webInstallJob('failed');

  failed.error.message = 'Нет доступа к источнику фикстуры.';
  failed.stage = 'fetching';

  const { wrapper, state, calls } = await mountInstallDialog(t, { job: failed });

  assert.equal(wrapper.get('[data-role="install-result"]').text(), failed.error.message);
  assert.equal(wrapper.get('[aria-current="step"]').text(), '2 Проверка');
  assert.equal(wrapper.find('[data-role="install-retry"]').exists(), true);
  await wrapper.get('[data-role="install-retry"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'forgetJob').length, 1);
  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'source');
  state.job = webInstallJob('recovery_required');
  await nextTick();
  assert.equal(wrapper.find('[data-role="install-retry"]').exists(), false);
  assert.equal(wrapper.find('[data-role="install-start"]').exists(), false);
  assert.match(wrapper.get('[data-role="install-result"]').text(), /Копии сохранены/u);
  await wrapper.get('[data-role="install-close"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'forgetJob').length, 1);
  assert.equal(state.job.status, 'recovery_required');
});

test('D10: ручные правки требуют force, startUpdate сохраняет предупреждение', async (t) => {
  const plugin = {
    id: 'demo',
    name: 'Демо',
    install: webInstallInfo({ localChanges: true }),
  };
  const { wrapper, calls } = await mountInstallDialog(t, {}, { mode: 'update', plugin },
    ({ state, calls }) => {
    state.listVersions = async (url) => {
      calls.push(['listVersions', [url]]);
      state.versionsInputKey = url.trim();
      state.versionsUrl = url;
      state.versions = [{
        version: '1.2.0',
        tag: 'v1.2.0',
        sha: 'a'.repeat(40),
      }];
    };
  });

  assert.equal(calls.filter(([method]) => method === 'listVersions').length, 1);
  assert.deepEqual(calls.find(([method]) => method === 'listVersions')[1], [plugin.install.source.url]);
  assert.match(wrapper.text(), /Установлена v1\.1\.0 из/u);
  assert.match(wrapper.text(), /В установленной копии есть ручные правки/u);
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, true);
  assert.equal(wrapper.find('[data-role="install-replace-modified"]').exists(), true);
  await wrapper.get('[data-role="install-replace-modified"]').setValue(true);
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, false);
  await wrapper.get('[data-role="install-start"]').trigger('click');
  assert.deepEqual(calls.find(([method]) => method === 'startUpdate')[1], ['demo', '1.2.0', true]);
  assert.match(wrapper.text(), /Отложить правки в резерв/u);
});

test('D11: terminal в закрытом диалоге показывается при открытии, автоматического forget нет', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t, { job: webInstallJob('running') });

  for (const status of ['done', 'failed', 'interrupted']) {
    await wrapper.setProps({ open: false });
    state.job = webInstallJob(status);
    await wrapper.setProps({ open: true });
    await flushPromises();
    assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'result');
    assert.equal(wrapper.find('[data-role="install-result"]').exists(), true);
    assert.equal(calls.filter(([method]) => method === 'forgetJob').length, 0);
  }
});

test('D12: чужой глобальный job определяет заголовок/id/source, инициатор не запускает поиск', async (t) => {
  const job = webInstallJob('ready', 'update');

  job.pluginId = 'other';
  job.preview.id = 'other';
  job.preview.name = 'Другой демо';

  const plugin = {
    id: 'demo',
    name: 'Инициатор',
    install: webInstallInfo(),
  };
  const { wrapper, state, calls } = await mountInstallDialog(t, { job }, { mode: 'update', plugin });

  assert.equal(wrapper.find('[data-role="install-heading"]').exists(), true);
  assert.equal(wrapper.get('[data-role="install-heading"]').text(), 'Обновление «Другой демо»');
  assert.equal(wrapper.text().includes('Инициатор'), false);
  assert.equal(calls.filter(([method]) => method === 'listVersions').length, 0);
  state.job = webInstallJob('running', 'update', { pluginId: 'other', source: job.source });
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-job-id"]').text(), 'other');
  assert.equal(wrapper.get('[data-role="install-job-source"]').text().includes(job.source.url), true);
});

test('D13: pending apply/reconciling важнее ready, нет повторных apply/cancel и процентов', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t, {
    job: webInstallJob(),
    pendingAction: 'apply',
  });

  for (const reconciling of [false, true]) {
    state.pendingAction = reconciling ? null : 'apply';
    state.reconciling = reconciling;
    await nextTick();
    assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'progress');
    assert.match(wrapper.text(), /Уточняю исход/u);
    assert.equal(wrapper.find('[data-role="install-apply"]').exists(), false);
    assert.equal(wrapper.find('[data-role="install-cancel"]').exists(), false);
    assert.equal(wrapper.get('[data-role="install-progress"]').attributes('aria-valuenow'), undefined);
    assert.equal(calls.filter(([method]) => ['apply', 'cancel'].includes(method)).length, 0);
  }
});

test('D14: известные apply отказы видны в ready рядом с доступной повторной кнопкой', async (t) => {
  const { wrapper, state } = await mountInstallDialog(t, { job: webInstallJob() });

  for (const code of ['plugin_busy', 'plugin_stop_required', 'local_changes', 'preview_stale']) {
    state.error = 'Объяснение ' + code;
    await nextTick();
    assert.equal(wrapper.find('[data-role="install-error"]').exists(), true);
    assert.equal(wrapper.get('[data-role="install-error"]').text(), state.error);
    assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'ready');
    assert.equal(wrapper.get('[data-role="install-apply"]').element.disabled, false);
  }
});

test('D15: health виден без job, блокирует start/apply; recovery нельзя забыть', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t);

  await wrapper.get('[data-role="install-url"]').setValue('file:///fixture.git');
  state.versionsInputKey = 'file:///fixture.git';
  state.versionsUrl = 'file:///fixture.git';
  state.versions = [{
    version: '1.1.0',
    tag: 'v1.1.0',
    sha: 'a'.repeat(40),
  }];
  await nextTick();
  await wrapper.get('[data-role="install-version"]').setValue('1.1.0');
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, false);
  state.recoveryError = { code: 'recovery_required', message: 'Сохранённые копии требуют разбора.' };
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, true);
  assert.equal(wrapper.find('[data-role="install-recovery"]').exists(), true);
  assert.match(wrapper.get('[data-role="install-recovery"]').text(), /копии требуют разбора/u);
  state.job = webInstallJob();
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-apply"]').element.disabled, true);
  assert.equal(wrapper.get('[data-role="install-cancel"]').element.disabled, true);
  state.job = webInstallJob('recovery_required');
  await nextTick();
  assert.equal(wrapper.find('[data-role="install-retry"]').exists(), false);
  await wrapper.get('[data-role="install-close"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'forgetJob').length, 0);
});

test('D16: один apply; закрытие сохраняет job, unmount блокирует позднее открытие', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t, { job: webInstallJob() });

  state.$dispose = () => calls.push(['dispose', []]);
  wrapper.get('[data-role="install-apply"]').element.click();
  wrapper.get('[data-role="install-apply"]').element.click();
  await nextTick();
  assert.equal(calls.filter(([method]) => method === 'apply').length, 1);
  await wrapper.get('.ui-dialog-overlay').trigger('click');
  assert.equal(wrapper.emitted('update:open').at(-1)[0], false);
  assert.equal(calls.filter(([method]) => ['cancel', 'dispose', 'forgetJob'].includes(method)).length, 0);
  wrapper.unmount();

  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  t.after(() => release());

  const late = await mountInstallDialog(t, {}, {
    mode: 'update',
    plugin: { id: 'demo', install: webInstallInfo() },
  }, ({ state, calls }) => {
    state.loadJob = async () => {
      calls.push(['loadJob', []]);
      await pending;
    };
  });

  late.wrapper.unmount();
  release();
  await flushPromises();
  assert.equal(late.calls.filter(([method]) => method === 'listVersions').length, 0);
});

test('D17: bootstrap занимает окно до current; найденный ready не мигает формой', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  t.after(() => release());

  const { wrapper, state } = await mountInstallDialog(t, {}, {}, ({ state }) => {
    state.loadJob = async () => {
      await pending;
      state.job = webInstallJob();
    };
  });

  assert.equal(wrapper.find('[data-role="install-loading"]').exists(), true);
  assert.equal(wrapper.find('[data-role="install-url"]').exists(), false);
  assert.equal(wrapper.find('[data-role="install-start"]').exists(), false);
  assert.equal(wrapper.find('.ui-dialog__footer').exists(), true);
  release();
  await flushPromises();
  assert.equal(wrapper.find('[data-role="install-loading"]').exists(), false);
  assert.equal(wrapper.find('[data-role="install-preview"]').exists(), true);

  let refresh;

  state.loadJob = () => new Promise((resolve) => {
    refresh = resolve;
  });
  await wrapper.setProps({ open: false });
  await wrapper.setProps({ open: true });
  assert.equal(wrapper.find('[data-role="install-preview"]').exists(), true);
  assert.equal(wrapper.find('[data-role="install-loading"]').exists(), false);
  assert.equal(wrapper.get('[data-role="install-apply"]').element.disabled, true);
  refresh();
  await flushPromises();
  assert.equal(wrapper.get('[data-role="install-apply"]').element.disabled, false);
});

test('D18: ошибку current можно перечитать без запуска новой установки', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t, {}, {}, ({ state }) => {
    state.loadJob = async () => {
      state.error = 'Связь прервана.';
    };
  });

  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'unavailable');
  assert.equal(wrapper.get('[data-role="install-error"]').text(), 'Связь прервана.');
  assert.equal(wrapper.find('[data-role="install-start"]').exists(), false);
  state.loadJob = async () => {
    state.error = null;
  };
  await wrapper.get('[data-role="install-reload"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'source');
  assert.equal(calls.filter(([method]) => method === 'startInstall').length, 0);
});

test('D19: Enter ищет версии; поле и подсказка остаются на месте во время ответа', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  t.after(() => release());

  const { wrapper, calls } = await mountInstallDialog(t, {}, {}, ({ state, calls }) => {
    state.listVersions = async (url) => {
      calls.push(['listVersions', [url]]);
      state.versionsLoading = true;
      await pending;
      state.versionsInputKey = url;
      state.versionsUrl = url;
      state.versions = [{
        version: '1.2.0',
        tag: 'v1.2.0',
        sha: 'a'.repeat(40),
      }];
      state.versionsLoading = false;
    };
  });
  const field = wrapper.get('[data-role="install-version"]').element;
  const hint = wrapper.get('#plugin-install-version-status').element;

  assert.equal(field.disabled, true);
  await wrapper.get('[data-role="install-url"]').setValue('https://example.invalid/demo.git');
  await wrapper.get('form').trigger('submit');
  assert.equal(wrapper.get('[data-role="install-find"]').element.disabled, true);
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, true);
  assert.equal(wrapper.get('[data-role="install-version"]').element === field, true);
  assert.equal(wrapper.get('#plugin-install-version-status').element === hint, true);
  assert.match(hint.textContent, /Ищем версии/u);
  await wrapper.get('form').trigger('submit');
  assert.equal(calls.filter(([method]) => method === 'listVersions').length, 1);
  release();
  await flushPromises();
  assert.equal(field.value, '1.2.0');
  assert.equal(field.disabled, false);
  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, false);
});

test('D20: повтор обновления после ошибки снова получает версии исходного плагина', async (t) => {
  const plugin = {
    id: 'demo',
    name: 'Демо',
    install: webInstallInfo(),
  };
  const { wrapper, calls } = await mountInstallDialog(t, {
    job: webInstallJob('failed', 'update'),
  }, { mode: 'update', plugin });

  await wrapper.get('[data-role="install-retry"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'), 'source');
  assert.deepEqual(calls.find(([method]) => method === 'listVersions')[1], [plugin.install.source.url]);
});

test('D21: успешный итог завершает все шаги и сохраняет сведения об установленном пакете', async (t) => {
  const job = webInstallJob('done');
  const { wrapper, state } = await mountInstallDialog(t, { job });

  assert.equal(wrapper.findAll('.install-steps [data-complete="true"]').length, 3);
  assert.equal(wrapper.find('[aria-current="step"]').exists(), false);
  assert.equal(wrapper.get('[data-role="install-close"]').text(), 'Готово');
  assert.equal(wrapper.get('.install-package-summary').text().includes(job.source.url), true);
  assert.equal(wrapper.get('.install-package-summary').text().includes(job.preview.name), true);
  state.job = webInstallJob('ready');
  await nextTick();
  assert.equal(wrapper.findAll('.install-steps [data-complete="true"]').length, 2);
  assert.equal(wrapper.get('[aria-current="step"]').text(), '3 Установка');
});

test('D22: новый шаг сбрасывает прокрутку diff, повторный snapshot сохраняет', async (t) => {
  const { wrapper, state } = await mountInstallDialog(t, { job: webInstallJob() });
  const scroll = wrapper.get('[data-role="install-scroll"]').element;

  scroll.scrollTop = 200;
  state.job = webInstallJob('ready');
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-scroll"]').element.scrollTop, 200);
  state.job = webInstallJob('applying');
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-scroll"]').element.scrollTop, 0);
  wrapper.get('[data-role="install-scroll"]').element.scrollTop = 100;
  state.job = webInstallJob('done');
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-scroll"]').element.scrollTop, 0);
});

test('D23: крестик в постоянной шапке закрывает окно, сохраняя активную установку', async (t) => {
  const { wrapper, state, calls } = await mountInstallDialog(t, { job: webInstallJob('running') });

  await wrapper.get('[aria-label="Закрыть окно установки"]').trigger('click');
  assert.equal(wrapper.emitted('update:open').at(-1)[0], false);
  assert.equal(state.job.status, 'running');
  assert.equal(calls.filter(([method]) => ['cancel', 'forgetJob'].includes(method)).length, 0);
});

const sourceStageIcon = 'M7 7v10m0-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'
  + 'm0-6h5a5 5 0 0 0 5-5V7m0 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z';

const dialogVisualCases = [
  {
    "name": "loading",
    "state": {},
    "props": {},
    "boot": "loading",
    "expected": {
      "screen": "loading",
      "tone": "accent",
      "heading": "Проверяем состояние",
      "description": "Ищем незавершённую установку.",
      "icon": null,
      "footer": "Проверяем состояние установки.",
      "resultClass": null,
      "steps": [
        [
          "true",
          "false"
        ],
        [
          "false",
          "false"
        ],
        [
          "false",
          "false"
        ]
      ]
    }
  },
  {
    "name": "unavailable",
    "state": {},
    "props": {},
    "boot": "unavailable",
    "expected": {
      "screen": "unavailable",
      "tone": "danger",
      "heading": "Нет связи с GrigDesk",
      "description": "Повторите загрузку, чтобы продолжить.",
      "icon": "M12 5v9m0 3v2",
      "footer": "Проверяем состояние установки.",
      "resultClass": null,
      "steps": [
        [
          "true",
          "false"
        ],
        [
          "false",
          "false"
        ],
        [
          "false",
          "false"
        ]
      ]
    }
  },
  {
    "name": "source-install",
    "state": {},
    "props": {},
    "boot": null,
    "expected": {
      "screen": "source",
      "tone": "accent",
      "heading": "Подключите репозиторий",
      "description": "Найдите релиз, который хотите установить.",
      "icon": sourceStageIcon,
      "footer": "Установка — только после подтверждения.",
      "resultClass": null,
      "steps": [
        [
          "true",
          "false"
        ],
        [
          "false",
          "false"
        ],
        [
          "false",
          "false"
        ]
      ]
    }
  },
  {
    "name": "source-update",
    "state": {},
    "props": {
      "mode": "update",
      "plugin": {
        id: 'demo',
        name: 'Демо',
        install: webInstallInfo(),
      }
    },
    "boot": null,
    "expected": {
      "screen": "source",
      "tone": "accent",
      "heading": "Выберите новую версию",
      "description": "Найдите релиз, который хотите установить.",
      "icon": sourceStageIcon,
      "footer": "Установка — только после подтверждения.",
      "resultClass": null,
      "steps": [
        [
          "true",
          "false"
        ],
        [
          "false",
          "false"
        ],
        [
          "false",
          "false"
        ]
      ]
    }
  },
  {
    "name": "running",
    "state": {
      "job": webInstallJob('running', 'install', { stage: 'fetching', percent: 40 })
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "progress",
      "tone": "accent",
      "heading": "Скачивание из источника",
      "description": "Работа продолжится, даже если закрыть окно.",
      "icon": null,
      "footer": "Закрытие окна не отменяет установку.",
      "resultClass": null,
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "true",
          "false"
        ],
        [
          "false",
          "false"
        ]
      ]
    }
  },
  {
    "name": "applying",
    "state": {
      "job": webInstallJob('applying')
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "progress",
      "tone": "accent",
      "heading": "Применяем изменения",
      "description": "Работа продолжится, даже если закрыть окно.",
      "icon": null,
      "footer": "Закрытие окна не отменяет установку.",
      "resultClass": null,
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "true",
          "false"
        ]
      ]
    }
  },
  {
    "name": "reconciling",
    "state": {
      "job": webInstallJob('ready'),
      "reconciling": true
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "progress",
      "tone": "accent",
      "heading": "Уточняю исход",
      "description": "Работа продолжится, даже если закрыть окно.",
      "icon": null,
      "footer": "Закрытие окна не отменяет установку.",
      "resultClass": null,
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "true",
          "false"
        ]
      ]
    }
  },
  {
    "name": "ready",
    "state": {
      "job": webInstallJob('ready')
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "ready",
      "tone": "accent",
      "heading": "Всё готово к установке",
      "description": "Проверьте пакет и подтвердите изменения.",
      "icon": "m5 12 4 4L19 6",
      "footer": "Проверьте источник перед установкой.",
      "resultClass": null,
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "true",
          "false"
        ]
      ]
    }
  },
  {
    "name": "done-install",
    "state": {
      "job": webInstallJob('done')
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "result",
      "tone": "success",
      "heading": "Установка завершена",
      "description": "Плагин сохранён. Ниже — дальнейшие действия.",
      "icon": "m5 12 4 4L19 6",
      "footer": "Изменения сохранены в GrigDesk.",
      "resultClass": null,
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ]
      ]
    }
  },
  {
    "name": "done-rollback",
    "state": {
      "job": webInstallJob('done', 'rollback')
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "result",
      "tone": "success",
      "heading": "Версия восстановлена",
      "description": "Плагин сохранён. Ниже — дальнейшие действия.",
      "icon": "m5 12 4 4L19 6",
      "footer": "Изменения сохранены в GrigDesk.",
      "resultClass": null,
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ]
      ]
    }
  },
  {
    "name": "failed",
    "state": {
      "job": webInstallJob('failed')
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "result",
      "tone": "danger",
      "heading": "Установка не выполнена",
      "description": "Подробности операции приведены ниже.",
      "icon": "M12 5v9m0 3v2",
      "footer": "Результат операции сохранён.",
      "resultClass": "ui-inline-message--danger",
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "true",
          "false"
        ]
      ]
    }
  },
  {
    "name": "cancelled",
    "state": {
      "job": webInstallJob('cancelled')
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "result",
      "tone": "accent",
      "heading": "Установка отменена",
      "description": "Можно закрыть окно и вернуться к каталогу.",
      "icon": "M12 5v9m0 3v2",
      "footer": "Результат операции сохранён.",
      "resultClass": "ui-inline-message--neutral",
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "true",
          "false"
        ]
      ]
    }
  },
  {
    "name": "recovery_required",
    "state": {
      "job": webInstallJob('recovery_required')
    },
    "props": {},
    "boot": null,
    "expected": {
      "screen": "result",
      "tone": "warning",
      "heading": "Требуется восстановление",
      "description": "Подробности операции приведены ниже.",
      "icon": "M12 5v9m0 3v2",
      "footer": "Результат операции сохранён.",
      "resultClass": "ui-inline-message--neutral",
      "steps": [
        [
          "false",
          "true"
        ],
        [
          "false",
          "true"
        ],
        [
          "true",
          "false"
        ]
      ]
    }
  }
];

/**
 * Снимок содержит только скаляры внешнего вида реального диалога.
 * Узлы и Vue wrappers не попадают в assert и не раскрывают граф DOM при падении.
 */
function dialogVisualSnapshot(wrapper) {
  const stage = wrapper.get('.install-stage-heading');
  const icon = stage.find('.install-stage-icon path');
  const result = wrapper.find('[data-role="install-result"]');

  return {
    screen: wrapper.get('[data-role="plugin-install-dialog"]').attributes('data-view'),
    tone: stage.attributes('data-tone'),
    heading: stage.get('h3').text(),
    description: stage.get('p').text(),
    icon: icon.exists() ? icon.attributes('d') : null,
    footer: wrapper.get('.install-footer-hint').text(),
    resultClass: result.exists()
      ? result.classes().find((name) => name.startsWith('ui-inline-message--')) ?? null : null,
    steps: wrapper.findAll('.install-steps li').map((step) => [
      step.attributes('data-current'),
      step.attributes('data-complete'),
    ]),
  };
}

for (const scenario of dialogVisualCases) {
  test(`D24: прежние тексты, тоны, иконки и шаги ${scenario.name}`,
    { timeout: 60_000 }, async (t) => {
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });

      t.after(() => release());

      const { wrapper } = await mountInstallDialog(t, scenario.state, scenario.props, ({ state }) => {
        if (scenario.boot === 'loading') {
          state.loadJob = async () => {
            await held;
          };
        } else if (scenario.boot === 'unavailable') {
          state.loadJob = async () => {
            state.error = 'Нет связи.';
          };
        }
      });

      try {
        assert.deepEqual(dialogVisualSnapshot(wrapper), scenario.expected);
      } finally {
        release();
      }
    });
}

test('CAT-DLG1: unknown source и offline различимы, повторное открытие не теряет warning', async (t) => {
  const { wrapper, calls } = await mountInstallDialog(t, { job: webInstallJob() });

  assert.match(wrapper.get('[data-source-notice]').text(), /Не удалось проверить источник/u);
  assert.equal(wrapper.get('[data-role="install-apply"]').text(), 'Установить из этого источника');
  globalThis.__catalogUi.index = {
    schemaVersion: 1,
    generatedAt: '2026-10-22T10:00:00.000Z',
    plugins: []
  };
  globalThis.__catalogUi.state = 'fresh';
  await nextTick();
  assert.match(wrapper.get('[data-source-notice]').text(), /Установка из неизвестного источника/u);
  assert.match(wrapper.get('[data-source-notice]').text(), /доступ к файлам и запуску команд/u);
  globalThis.__catalogUi.loading = true;
  await nextTick();
  assert.equal(wrapper.get('[data-role="install-apply"]').element.disabled, true);
  globalThis.__catalogUi.loading = false;
  await wrapper.setProps({ open: false });
  await wrapper.setProps({ open: true });
  await flushPromises();
  assert.match(wrapper.get('[data-source-notice]').text(), /Установка из неизвестного источника/u);
  await wrapper.get('[data-role="install-apply"]').trigger('click');
  assert.equal(calls.filter(([method]) => method === 'apply').length, 1);
});

test('CAT-DLG2: происхождение берётся из actual job, а не props другой карточки', async (t) => {
  const { catalogFixture } = await import('../helpers/pluginCatalog.js');
  const data = catalogFixture();
  const job = webInstallJob();

  job.source = data.entry.source;
  job.preview.source = data.entry.source;


  const { wrapper, state } = await mountInstallDialog(t, { job }, {
    plugin: {
      id: 'other',
      name: 'Other',
      system: false
    },
  });

  globalThis.__catalogUi.index = data.index;
  globalThis.__catalogUi.state = 'fresh';
  await nextTick();
  assert.equal(wrapper.get('[data-source-notice]').attributes('data-membership'), 'community');
  state.job.source = { kind: 'git', url: 'https://github.com/other/demo.git' };
  state.job.preview.source = state.job.source;
  await nextTick();
  assert.equal(wrapper.get('[data-source-notice]').attributes('data-membership'), 'external');
});

test('CAT-OFFICIAL: официальный пакет скрывает общие риски, но сохраняет предупреждения операции',
  async (t) => {
    const { catalogFixture } = await import('../helpers/pluginCatalog.js');
    const data = catalogFixture();
    const job = webInstallJob();
    const operationWarning = 'Установленная версия будет понижена.';

    data.index.plugins[0].origin = 'official';
    job.source = data.entry.source;
    job.preview.source = data.entry.source;
    job.preview.warnings = ['Код плагина выполняется с правами GrigDesk.', moduleWarning, operationWarning];

    const { wrapper, state } = await mountInstallDialog(t, { job });

    globalThis.__catalogUi.index = data.index;
    globalThis.__catalogUi.state = 'fresh';
    await nextTick();
    assert.equal(wrapper.get('[data-source-notice]').attributes('data-membership'), 'official');
    assert.doesNotMatch(wrapper.get('[data-role="install-preview"]').text(), /правами|вашей сессией/u);
    assert.equal(wrapper.get('[data-role="install-warning"]').text(), operationWarning);

    state.job.source = { kind: 'git', url: 'https://github.com/other/demo.git' };
    state.job.preview.source = state.job.source;
    await nextTick();
    assert.match(wrapper.get('[data-role="install-preview"]').text(), /правами GrigDesk/u);
    assert.equal(wrapper.get('[data-source-notice]').attributes('data-membership'), 'external');
  });

test('CAT-DLG5: ready и reopen запускают проверку; apply ждёт её фактического исхода', async (t) => {
  const { wrapper, state } = await mountInstallDialog(t);
  const reads = [];
  let rejectRead;
  const response = new Promise((_resolve, reject) => {
    rejectRead = reject;
  });
  const catalog = globalThis.__catalogUi;

  catalog.loadIndex = async (force) => {
    reads.push(force);
    catalog.loading = true;

    try {
      await response;
    } catch {
      catalog.index = null;
      catalog.state = 'unavailable';
    } finally {
      catalog.loading = false;
    }
  };
  state.job = webInstallJob();
  await nextTick();
  assert.deepEqual(reads, [true]);
  assert.equal(wrapper.get('[data-role="install-apply"]').element.disabled, true);
  rejectRead(new Error('catalog offline'));
  await flushPromises();
  assert.equal(wrapper.get('[data-role="install-apply"]').element.disabled, false);
  assert.equal(wrapper.get('[data-source-notice]').attributes('data-membership'), 'unverified');
  await wrapper.setProps({ open: false });
  await wrapper.setProps({ open: true });
  await flushPromises();
  assert.deepEqual(reads, [true, true]);
});

test('CAT-DLG3: preset выбирает точную версию и отправляет SHA, current имеет приоритет', async (t) => {
  const selection = {
    id: 'demo',
    source: { kind: 'git', url: 'https://github.com/example/demo.git' },
    target: {
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: 'a'.repeat(40),
      api: 1,
      minGrigDeskVersion: '1.0.0'
    },
  };
  const { wrapper, calls } = await mountInstallDialog(t, {}, { catalogSelection: selection }, (fixture) => {
    fixture.state.listVersions = async (url) => {
      fixture.calls.push(['listVersions', [url]]);
      fixture.state.versionsInputKey = url.trim();
      fixture.state.versionsUrl = selection.source.url;
      fixture.state.versions = [selection.target];
    };
  });

  assert.equal(wrapper.get('[data-role="install-url"]').element.value, selection.source.url);
  assert.equal(wrapper.get('[data-role="install-url"]').element.disabled, true);
  assert.equal(wrapper.get('[data-role="install-version"]').element.value, '1.1.0');
  assert.equal(calls.some(([name]) => name === 'startInstall'), false);
  await wrapper.get('[data-role="install-start"]').trigger('click');
  assert.deepEqual(calls.find(([name]) => name === 'startInstall')[1],
    [selection.source.url, '1.1.0', false, 'demo', selection.target.sha]);
  wrapper.unmount();

  const existing = await mountInstallDialog(t, { job: webInstallJob() }, { catalogSelection: selection });

  assert.equal(existing.wrapper.find('[data-role="install-url"]').exists(), false);
  assert.equal(existing.calls.some(([name]) => name === 'listVersions' || name === 'startInstall'), false);
});

test('CAT-DLG4: moved preset tag блокирует подготовку ещё в списке версий', async (t) => {
  const selection = {
    id: 'demo',
    source: { kind: 'git', url: 'https://github.com/example/demo.git' },
    target: {
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: 'a'.repeat(40),
      api: 1,
      minGrigDeskVersion: null
    },
  };
  const { wrapper, calls } = await mountInstallDialog(t, {}, { catalogSelection: selection }, (fixture) => {
    fixture.state.listVersions = async (url) => {
      fixture.state.versionsInputKey = url.trim();
      fixture.state.versionsUrl = url;
      fixture.state.versions = [{ ...selection.target, sha: 'b'.repeat(40) }];
    };
  });

  assert.equal(wrapper.get('[data-role="install-start"]').element.disabled, true);
  assert.match(wrapper.text(), /Выбранная версия изменилась/u);
  assert.equal(calls.some(([name]) => name === 'startInstall'), false);
});
