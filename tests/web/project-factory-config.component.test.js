import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const CONFIG = {
  profile: 'demo',
  capabilities: ['route-v2'],
  variables: {
    profileSh: [
      {
        name: 'PROFILE_LOOP_MAX_ROUNDS',
        value: '20',
        literal: true,
        editable: true,
        present: true,
        reason: null
      },
      {
        name: 'PROFILE_DYNAMIC',
        value: null,
        literal: false,
        editable: false,
        present: true,
        reason: 'not_literal_metadata'
      },
    ],
    dashboard: [],
  },
  runners: {
    PROJECT_RUNNER_PRIMARY: 'codex',
    PROJECT_RUNNER_FAILOVER: 'claude',
    MODEL_DEFAULT_CODEX_EXACT: 'model-a',
    MODEL_DEFAULT_CODEX_EFFORT: 'high',
    CONFIG_REVISION: '1',
  },
};

/**
 * Управляемый барьер удерживает только нужный сетевой ответ.
 * Таймеры и реальные серверные профили в проверке не участвуют.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test('Конфигурация фабрики: реальные client/controls и изолированные ответы',
  { timeout: 60_000 }, async (t) => {
  const browser = await createUiBrowser('http://grigdesk.test/#/projects');


  t.after(() => browser.close());

  const Component = await compileVue(webFile('src/views/projects/ProjectFactoryConfig.vue'), {
    stubs: { './apiClient.ts': `
export const api = {
  get: (...args) => globalThis.__factoryPanelHarness.get(...args),
  patch: (...args) => globalThis.__factoryPanelHarness.patch(...args),
};` },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  /**
   * У каждого подтеста свой снимок сети. DOM/Vue singleton общий для файла,
   * компонент и global harness удаляются раньше закрытия окна родителем.
   */
  async function fixture(subtest, overrides, props = {}) {
    const state = { config: structuredClone(CONFIG), calls: [] };
    const harness = {
      get: async (url) => {
        state.calls.push(['GET', url]);

        return structuredClone(state.config);
      },
      patch: async (url, body) => {
        state.calls.push(['PATCH', url, structuredClone(body)]);

        if (url.endsWith('/variables')) {
          for (const change of body.changes) {
            state.config.variables.profileSh.find((item) => item.name === change.name).value = change.to;
          }

          return { variables: state.config.variables.profileSh };
        }

        for (const operation of body.operations) {
          if (operation.kind === 'runner') {
            state.config.runners.PROJECT_RUNNER_PRIMARY = operation.primary;
            state.config.runners.PROJECT_RUNNER_FAILOVER = operation.failover;
          }
        }

        return { runners: state.config.runners };
      },
    };

    const base = { ...harness };

    Object.assign(harness, overrides(state, base));
    globalThis.__factoryPanelHarness = harness;


    const wrapper = mount(Component, {
      attachTo: browser.document.querySelector('#mount'),
      props: { detail: { id: 'demo' }, ...props },
    });


    subtest.after(() => {
      if (wrapper.exists()) {
        wrapper.unmount();
      }

      delete globalThis.__factoryPanelHarness;
    });
    await flushPromises();

    const field = (name) => {
      const found = wrapper.find(`[data-test="field-${name}"]`);


      assert.equal(found.exists(), true, `нет поля ${name}`);

      return found;
    };
    /**
     * Нажимает настоящий control в общем document и ждёт очередь Vue.
     * Отсутствие кнопки — явный assert вместо ошибки обращения к DOM.
     */
    const click = async (name) => {
      const button = browser.document.querySelector(`[data-test="${name}"]`);


      assert.equal(Boolean(button), true, `нет кнопки ${name}`);
      button.click();
      await flushPromises();
    };

    return {
      wrapper,
      state,
      harness,
      field,
      click
    };
  }

  await t.test('RE-B3-01: переменная, read-only и полный preview пары/модели', async (s) => {
    const f = await fixture(s, () => ({}));

    assert.equal(f.wrapper.find('[data-test="profile-capabilities"]').exists(), true);
    assert.equal(f.wrapper.find('[data-test="profile-capabilities"]').text().includes('route-v2'), true);
    assert.equal(f.wrapper.find('[data-test="field-PROFILE_DYNAMIC"]').exists(), false);
    assert.equal(f.wrapper.find('[data-test="readonly-PROFILE_DYNAMIC"]').exists(), true);
    assert.equal(f.wrapper.find('[data-test="field-CONFIG_REVISION"]').exists(), false);
    await f.field('PROFILE_LOOP_MAX_ROUNDS').setValue('40');
    await f.field('PROJECT_RUNNER_PRIMARY').setValue('qwen');
    await f.field('MODEL_DEFAULT_CODEX_EXACT').setValue('model-b');
    await f.click('apply-config');

    const summary = browser.document.querySelector('[data-test="config-summary"]');


    assert.equal(summary.textContent.includes('20 → 40'), true);
    assert.equal(summary.textContent.includes('PROJECT_RUNNER_FAILOVER'), true);
    assert.equal(summary.textContent.includes('claude → claude'), true);
    assert.equal(summary.textContent.includes('MODEL_DEFAULT_CODEX_EFFORT'), true);
    assert.equal(summary.textContent.includes('high → high'), true);
    await f.click('confirm-config');

    const patches = f.state.calls.filter(([method]) => method === 'PATCH');


    assert.deepEqual(patches[0], ['PATCH', '/api/profiles/demo/variables', {
      file: 'profile.sh',
      changes: [{
        name: 'PROFILE_LOOP_MAX_ROUNDS',
        from: '20',
        to: '40'
      }],
    }]);
    assert.deepEqual(patches[1], ['PATCH', '/api/profiles/demo/runners', { operations: [
      {
        kind: 'runner',
        primary: 'qwen',
        failover: 'claude'
      },
      {
        kind: 'model',
        role: 'DEFAULT',
        provider: 'codex',
        exact: 'model-b',
        effort: 'high'
      },
    ] }]);
  });

  await t.test('RE-B3-02: readonly и pending не позволяют отправить вторую запись', async (s) => {
    const hold = deferred();


    s.after(() => hold.resolve());


    const f = await fixture(s, (_state, base) => ({
      patch: async (...args) => {
        await hold.promise;

        return base.patch(...args);
      },
    }));


    await f.wrapper.setProps({ readonly: true });
    assert.equal(f.field('PROFILE_LOOP_MAX_ROUNDS').attributes('disabled') !== undefined, true);
    await f.click('apply-config');
    assert.equal(browser.document.querySelector('[data-test="confirm-config"]'), null);
    await f.wrapper.setProps({ readonly: false });
    await f.field('PROFILE_LOOP_MAX_ROUNDS').setValue('40');
    await f.click('apply-config');


    const confirm = browser.document.querySelector('[data-test="confirm-config"]');


    confirm.click();
    confirm.click();
    await flushPromises();
    assert.equal(f.wrapper.find('[data-test="apply-config"]').attributes('disabled') !== undefined, true);
    hold.resolve();
    await flushPromises();
    assert.equal(f.state.calls.filter(([method]) => method === 'PATCH').length, 1);
  });

  await t.test('RE-B3-03: 409 сохраняет намерение и показывает перечитанный факт', async (s) => {
    const f = await fixture(s, (state) => ({
      patch: async () => {
        state.config.variables.profileSh[0].value = '30';


        throw Object.assign(new Error('PROFILE_LOOP_MAX_ROUNDS changed'), { status: 409 });
      },
    }));


    await f.field('PROFILE_LOOP_MAX_ROUNDS').setValue('40');
    await f.click('apply-config');
    await f.click('confirm-config');

    assert.equal(f.wrapper.find('[data-test="config-conflict"]').exists(), true);
    assert.equal(f.field('PROFILE_LOOP_MAX_ROUNDS').element.value, '40');
    assert.equal(f.wrapper.find('[data-test="fact-PROFILE_LOOP_MAX_ROUNDS"]').text().includes('30'), true);
    await f.click('apply-config');
    assert.equal(browser.document.querySelector('[data-test="config-summary"]').textContent
      .includes('30 → 40'), true);
  });

  await t.test('RE-B3-07: 502 после одной операции снимает применённое и сохраняет остаток', async (s) => {
    const f = await fixture(s, (state) => ({
      patch: async (_url, body) => {
        state.calls.push(['PATCH', _url, structuredClone(body)]);
        state.config.runners.PROJECT_RUNNER_PRIMARY = 'qwen';
        state.config.runners.PROJECT_RUNNER_FAILOVER = 'claude,codex';


        throw Object.assign(new Error('second operation failed'), {
          status: 502, data: { appliedOperations: 1 },
        });
      },
    }));


    await f.field('PROJECT_RUNNER_PRIMARY').setValue('qwen');
    await f.field('PROJECT_RUNNER_FAILOVER').setValue('claude,codex');
    await f.field('MODEL_DEFAULT_CODEX_EXACT').setValue('model-b');
    await f.click('apply-config');
    await f.click('confirm-config');

    assert.equal(f.wrapper.find('[data-test="config-partial"]').text().includes('1'), true);
    assert.equal(f.field('PROJECT_RUNNER_PRIMARY').element.value, 'qwen');
    assert.equal(f.field('MODEL_DEFAULT_CODEX_EXACT').element.value, 'model-b');
    assert.equal(f.wrapper.find('[data-test="fact-MODEL_DEFAULT_CODEX_EXACT"]').text()
      .includes('model-a'), true);
    await f.click('apply-config');


    const text = browser.document.querySelector('[data-test="config-summary"]').textContent;


    assert.equal(text.includes('PROJECT_RUNNER_PRIMARY'), false);
    assert.equal(text.includes('model-a → model-b'), true);
  });

  await t.test('RE-B3-08: смена detail.id живого экземпляра обрывает очередь и изолирует ответ',
    async (s) => {
    const hold = deferred();


    s.after(() => hold.resolve());


    const f = await fixture(s, (state, base) => ({
      get: async (url) => url.includes('/other/')
        ? { ...structuredClone(CONFIG), profile: 'other' } : base.get(url),
      patch: async (url, body) => {
        state.calls.push(['PATCH', url, structuredClone(body)]);
        await hold.promise;

        return { variables: state.config.variables.profileSh };
      },
    }));


    await f.field('PROFILE_LOOP_MAX_ROUNDS').setValue('40');
    await f.field('PROJECT_RUNNER_PRIMARY').setValue('qwen');
    await f.click('apply-config');
    browser.document.querySelector('[data-test="confirm-config"]').click();
    await flushPromises();
    await f.wrapper.setProps({ detail: { id: 'other' } });
    await flushPromises();
    hold.resolve();
    await flushPromises();

    assert.equal(f.wrapper.attributes('data-profile'), 'other');
    assert.equal(f.field('PROFILE_LOOP_MAX_ROUNDS').element.value, '20');
    assert.equal(f.state.calls.filter(([method]) => method === 'PATCH').length, 1);
    await f.wrapper.setProps({ detail: { id: 'demo' } });
    await flushPromises();
    assert.equal(f.field('PROFILE_LOOP_MAX_ROUNDS').element.value, '40');
  });

  await t.test('RE-B3-11: размонтирование прекращает очередь, новый экземпляр читает факт', async (s) => {
    const hold = deferred();


    s.after(() => hold.resolve());


    const old = await fixture(s, (state) => ({
      patch: async (url, body) => {
        state.calls.push(['PATCH', url, structuredClone(body)]);
        await hold.promise;

        return { variables: state.config.variables.profileSh };
      },
    }));


    await old.field('PROFILE_LOOP_MAX_ROUNDS').setValue('40');
    await old.field('PROJECT_RUNNER_PRIMARY').setValue('qwen');
    await old.click('apply-config');
    browser.document.querySelector('[data-test="confirm-config"]').click();
    await flushPromises();
    old.wrapper.unmount();

    // ProjectsView снимает v-if формы при смене openedId до ответа HTTP.
    // Новый mount той же роли моделирует возврат после этой реальной границы.
    const fresh = await fixture(s, () => ({}));


    assert.equal(fresh.field('PROFILE_LOOP_MAX_ROUNDS').element.value, '20');
    hold.resolve();
    await flushPromises();

    assert.equal(old.state.calls.filter(([method]) => method === 'PATCH').length, 1);
    assert.equal(fresh.field('PROFILE_LOOP_MAX_ROUNDS').element.value, '20');
    assert.equal(fresh.state.calls.filter(([method]) => method === 'PATCH').length, 0);
  });

  await t.test('RE-B3-12: readonly true→false не возобновляет подтверждённую очередь', async (s) => {
    const hold = deferred();


    s.after(() => hold.resolve());


    const f = await fixture(s, (_state, base) => ({
      patch: async (...args) => {
        await hold.promise;

        return base.patch(...args);
      },
    }));


    await f.field('PROFILE_LOOP_MAX_ROUNDS').setValue('40');
    await f.field('PROJECT_RUNNER_PRIMARY').setValue('qwen');
    await f.click('apply-config');
    browser.document.querySelector('[data-test="confirm-config"]').click();
    await flushPromises();
    await f.wrapper.setProps({ readonly: true });
    await f.wrapper.setProps({ readonly: false });
    hold.resolve();
    await flushPromises();

    const patches = f.state.calls.filter(([method]) => method === 'PATCH');


    assert.equal(patches.length, 1);
    assert.equal(patches[0][1], '/api/profiles/demo/variables');
    assert.equal(f.field('PROJECT_RUNNER_PRIMARY').element.value, 'qwen');
    assert.equal(f.wrapper.find('[data-test="fact-PROFILE_LOOP_MAX_ROUNDS"]').text().includes('40'), true);
    await f.click('apply-config');


    const text = browser.document.querySelector('[data-test="config-summary"]').textContent;


    assert.equal(text.includes('PROJECT_RUNNER_PRIMARY'), true);
    assert.equal(text.includes('PROFILE_LOOP_MAX_ROUNDS'), false);
  });

  await t.test('RE-B3-09: отказ перечитывания блокирует apply до восстановления', async (s) => {
    let reads = 0;
    const f = await fixture(s, (state) => ({
      get: async () => {
        reads += 1;


        if (reads === 2) {
          throw new Error('read unavailable');
        }

        return structuredClone(state.config);
      },
      patch: async () => {
        throw Object.assign(new Error('unknown outcome'), { status: 502 });
      },
    }));


    await f.field('PROFILE_LOOP_MAX_ROUNDS').setValue('40');
    await f.click('apply-config');
    await f.click('confirm-config');
    assert.equal(f.field('PROFILE_LOOP_MAX_ROUNDS').element.value, '40');
    assert.equal(f.wrapper.find('[data-test="apply-config"]').attributes('disabled') !== undefined, true);
    await f.click('reload-config');
    assert.equal(f.wrapper.find('[data-test="apply-config"]').attributes('disabled'), undefined);
  });
});
