process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChatWorkdir } from '../../server/src/lib/chat/workdir.ts';
import { compileVue, webFile, singletonUrl, compileModule } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { LIBRARY_ID, detailDto, versionDto, stateDto, UNIT } from './helpers/studio3d-fixtures.js';

test('WL-03–08 следующие шаги, save CAS, агент и действия', async (t) => {
  await installUiBrowser(t);

  const { reactive, h } = await import(singletonUrl('vue'));
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  const calls = [];
  const file = {
    id: 'main',
    role: 'model',
    name: 'model.glb',
    url: '/api/studio3d/files/m/v/model.glb',
    sha256: 'a'.repeat(64),
    size: 50
  };
  const version = versionDto({
    status: 'ready',
    files: [file],
    mainFileId: 'main'
  });
  const detail = detailDto({
    versions: [version],
    incoming: ['agent.glb'],
    saveFolders: { demo: { main: 'models/people' } }
  });
  const offer = {
    provider: 'tripo',
    providerName: 'Tripo',
    operation: 'texture-model',
    group: 'texture',
    label: 'Текстуры',
    local: false,
    available: true,
    reason: null,
    fields: [],
    presets: [],
    note: null,
    priceKnown: true,
    quote: {
      total: 10,
      lines: [],
      unit: UNIT,
      usd: null,
      note: null
    }
  };
  const store = reactive({
    state: stateDto(),
    libraryId: LIBRARY_ID,
    detail,
    selectedVersion: version.id,
    offers: [offer, {
      ...offer,
      operation: 'rig',
      label: 'Скелет',
      group: 'rig',
      available: false,
      reason: 'Нет подходящей формы'
    }],
    quoted: null,
    busy: 0,
    loadOffers: async () => {},
    quote: async (body) => { store.quoted = {
      libraryId: LIBRARY_ID,
      quote: offer.quote,
      validation: {
        values: body.values,
        errors: [],
        warnings: []
      }
    }; },
    run: async (body) => {
      calls.push(['run', body]);

      return { model: detail.model, versions: [] };
    },
    addFromFile: async (...args) => calls.push(['incoming', ...args]),
    deleteVersion: async () => {
      const error = new Error('children');

      error.code = 'has_children';

      throw error;
    },
    lighten: async (...args) => calls.push(['lighten', ...args]),
    patchModel: async (...args) => calls.push(['patch', ...args]),
    deleteModel: async (...args) => calls.push(['deleteModel', ...args]),
    redownload: async () => {},
    save: async (model, vid, body) => {
      calls.push(['save', structuredClone(body)]);

      const count = calls.filter((call) => call[0] === 'save').length;

      if (count <= 2) {
        const error = new Error('Изменился файл');

        error.status = 409; error.code = count === 1 ? 'exists' : 'changed';
        error.body = { sha256: (count === 1 ? 'a' : 'b').repeat(64) };

        throw error;
      }

      return {
        libraryId: LIBRARY_ID,
        path: '/repo/models/people/Куб_Модель.glb',
        overwritten: true
      };
    }
  });

  globalThis.__studioModel = {
    store,
    calls,
    questions: []
  };

  const stubs = {
    '../../shared/viewer3d/ModelViewer.vue': 'export default {template:"<div />"};',
    '../../stores/studio3d.ts': 'export const useStudio3dStore=()=>globalThis.__studioModel.store;',
    '../../ui.ts': `export * from './src/ui.ts';
      export const confirmDialog=async(text)=>{globalThis.__studioModel.questions.push(text);
        return globalThis.__studioModel.allow !== false;};`,
    '../../shared/projectsApi.ts': `export const projectsApi={list:async()=>[
      {id:'demo',title:'Проект',archivedAt:null,defaultRepoKey:'main',repos:[{key:'main',
        dir:'/repo',exists:true}]}]};`,
    '../../stores/chat.ts': 'export const useChatStore=()=>({defModelRef:null});',
    'vue-router': 'export const useRouter=()=>({push:async()=>{}});',
  };
  const Steps = await compileVue(webFile('src/views/studio3d/NextSteps.vue'), { stubs });
  const steps = mount(Steps, { props: { modelId: detail.model.id, versionId: version.id } });

  t.after(() => steps.unmount());
  assert.match(steps.text(), /Нет подходящей формы/);
  await steps.findAll('button').find((button) => button.text().includes('Текстуры')).trigger('click');
  await new Promise(setImmediate);
  await steps.get('[data-context="studio-price"]').trigger('click');
  await new Promise(setImmediate);
  assert.equal(calls.find((call) => call[0] === 'run')[1].versionId, version.id);

  const Save = await compileVue(webFile('src/views/studio3d/SaveDialog.vue'), { stubs });
  const save = mount(Save, { props: {
    open: true,
    model: detail.model,
    version,
    folders: detail.saveFolders
  } });

  t.after(() => save.unmount());
  await new Promise(setImmediate);
  await save.vm.$nextTick();

  const selects = document.querySelectorAll('select');

  selects[0].value = 'demo';
  selects[0].dispatchEvent(new Event('change'));
  await save.vm.$nextTick();
  assert.equal(document.querySelector('[data-context="studio-save-folder"]').value, 'models/people');

  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Сохранить');

  button.click();
  await new Promise(setImmediate);

  const saves = calls.filter((call) => call[0] === 'save');

  assert.equal(saves.length, 3);
  assert.equal(saves[1][1].overwrite, true);
  assert.equal(saves[1][1].expectedSha256, 'a'.repeat(64));
  assert.equal(saves[2][1].expectedSha256, 'b'.repeat(64));
  assert.equal(globalThis.__studioModel.questions.length, 2);
  await save.setProps({ open: false });
  await new Promise(setImmediate);

  const Page = await compileVue(webFile('src/views/studio3d/ModelPage.vue'), { stubs });
  const page = mount(Page, { props: { section: 'details' } });

  t.after(() => page.unmount());
  assert.match(page.text(), /Готово к использованию/);
  assert.ok(page.get('.studio-model-result').text().includes('Сохранить в проект'));
  await page.findAll('button').find((item) => item.text().includes('Управление моделью')).trigger('click');
  await page.findAll('button').find((item) => item.text() === 'Облегчить').trigger('click');
  await new Promise(setImmediate);
  assert.equal(calls.some((call) => call[0] === 'lighten'), true);
  await page.findAll('button').find((item) => item.text() === 'Удалить версию').trigger('click');
  await new Promise(setImmediate);
  assert.match(page.text(), /Сначала удалите версии, сделанные из этой/);

  await t.test('WL-09 итог проверки скелета виден, выбор версии сохраняется', async (scenario) => {
    const common = {
      jobId: 'check-job',
      childId: 'check-child',
      at: version.updatedAt
    };
    const states = [
      [{ ...common, status: 'pending' }, /Проверяется…/],
      [{
        ...common,
        status: 'ready',
        riggable: true,
        rigType: 'biped'
      }, /Можно: двуногий/],
      [{
        ...common,
        status: 'ready',
        riggable: false,
        rigType: null
      }, /Нельзя:/],
      [{
        ...common,
        status: 'failed',
        error: { message: 'Проверка не удалась' }
      }, /Проверка не удалась/]
    ];

    for (const [check, text] of states) {
      store.detail.versions[0].rigCheck = check;
      await page.vm.$nextTick();
      assert.match(page.text(), text);
    }

    store.offers = [{
      ...offer,
      operation: 'rig-check',
      label: 'Проверка скелета',
      group: 'rig',
      quote: { ...offer.quote, total: 0 }
    }];

    const checking = mount(Steps, { props: { modelId: detail.model.id, versionId: version.id } });

    scenario.after(() => checking.unmount());
    await checking.findAll('button').find((button) => button.text().includes('Проверка скелета'))
      .trigger('click');
    await new Promise(setImmediate);
    await checking.get('[data-context="studio-price"]').trigger('click');
    await new Promise(setImmediate);
    assert.deepEqual(checking.emitted('created'), [[detail.model.id, version.id]]);
  });

  await t.test('WL-11 параметры версии показаны списком с русскими подписями', async () => {
    store.detail.versions[0].params = {
      category: 'character',
      view: 'front',
      rig_type: 'biped'
    };
    await page.vm.$nextTick();
    assert.equal(page.find('.studio-version-params').exists(), true);
    assert.match(page.text(), /Категория: персонаж/);
    assert.match(page.text(), /Вид: спереди/);
    assert.match(page.text(), /Тип тела: двуногий/);
    assert.doesNotMatch(page.text(), /tripo|character|front|"rig_type"/);
  });

  await t.test('WL-10 имя, категория и проект меняются; удаление подтверждается', async () => {
    const rename = page.findAll('button').find((button) => button.text() === 'Переименовать');

    assert.ok(Boolean(rename));
    await rename.trigger('click');
    await new Promise(setImmediate);
    await page.vm.$nextTick();

    /**
     * Поле диалога изменяется настоящим событием элемента, как при вводе человека.
     * Поиск ограничен data-context, чтобы открытый диалог сохранения не мешал проверке.
     */
    const change = async (context, value) => {
      const input = document.querySelector(`[data-context="${context}"]`);

      assert.ok(Boolean(input));
      input.value = value;
      input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
      await page.vm.$nextTick();
    };

    await change('studio-model-name', 'Имя после правки');
    await change('studio-model-category', 'character');
    await change('studio-model-project', 'demo');
    document.querySelector('[data-context="studio-model-save"]').click();
    await new Promise(setImmediate);
    assert.deepEqual(calls.find((call) => call[0] === 'patch'), ['patch', detail.model.id, {
      name: 'Имя после правки',
      category: 'character',
      project: 'demo'
    }]);

    const removeModel = page.findAll('button').find((button) => button.text() === 'Удалить модель');

    globalThis.__studioModel.allow = false;
    await removeModel.trigger('click');
    await new Promise(setImmediate);
    assert.equal(calls.some((call) => call[0] === 'deleteModel'), false);
    globalThis.__studioModel.allow = true;
    await removeModel.trigger('click');
    await new Promise(setImmediate);
    assert.deepEqual(calls.find((call) => call[0] === 'deleteModel'), ['deleteModel', detail.model.id]);
  });

  await t.test('WL-06/08 incoming и сравнение используют выбранную версию', async (scenario) => {
    const other = versionDto({
      id: 'other',
      status: 'ready',
      mainFileId: 'main',
      files: [{ ...file, url: '/api/studio3d/files/m/other/model.glb' }]
    });

    store.detail.versions.push(other);

    const viewer = mount(Page, { props: { compareVersionId: 'other' }, slots: {
      viewer: (props) => h('span', { 'data-compare': props.compareSrc }, props.src),
    } });

    scenario.after(() => viewer.unmount());
    assert.equal(viewer.get('[data-compare]').attributes('data-compare'), other.files[0].url);
    await page.setProps({ compareVersionId: other.id });

    const stopCompare = page.findAll('button').find((item) => item.text() === 'Убрать сравнение');

    assert.ok(Boolean(stopCompare));
    await stopCompare.trigger('click');
    assert.deepEqual(page.emitted('compare').at(-1), ['']);
    await viewer.findAll('button').find((item) => item.text() === 'Добавить версией').trigger('click');
    await new Promise(setImmediate);
    assert.deepEqual(calls.find((call) => call[0] === 'incoming'),
      ['incoming', detail.model.id, { incoming: 'agent.glb', parentVersionId: version.id }]);
  });

  await t.test('WL-05 штатный resolver допускает внешнюю библиотеку без проекта', async (scenario) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-agent-'));

    scenario.after(() => fs.rm(root, { recursive: true, force: true }));

    const grigdesk = path.join(root, 'grigdesk');
    const modelDirectory = path.join(root, 'library', 'hero');

    await fs.mkdir(grigdesk, { recursive: true });
    await fs.mkdir(path.join(modelDirectory, version.id), { recursive: true });
    await fs.mkdir(path.join(modelDirectory, 'incoming'));
    await fs.writeFile(path.join(modelDirectory, version.id, file.name), 'offline fixture');

    const { askStudioAgent } = await compileModule(webFile('src/features/studio3d/askAgent.ts'));
    const drafts = [];
    const routes = [];
    const chat = { defModelRef: null, newSession: (options) => drafts.push(options) };
    const router = { push: async (route) => routes.push(route) };
    const entry = {
      ...detail,
      modelDirectory,
      model: {
        ...detail.model,
        name: 'Пётр',
        project: null
      }
    };
    let capability = { switch: 'resume', roots: 'multi' };
    const preview = async (body) => ({ capability, target: await resolveChatWorkdir({
      workdir: body.candidate.workdir,
      provider: 'offline',
      caps: capability,
      config: { rootDir: grigdesk, profilesDir: path.join(grigdesk, 'profiles') },
      prefs: { read: () => ({ projects: {} }) },
      factoryState: { readEnv: async () => ({}) },
      trustedProject: async () => null
    }) });

    await askStudioAgent(entry, version, chat, router, preview);
    assert.deepEqual(drafts[0].workdir, { kind: 'path', path: modelDirectory });
    assert.equal(drafts[0].title, '3D · Пётр');
    assert.match(drafts[0].draft, new RegExp(`${modelDirectory}/${version.id}/${file.name}`));
    assert.match(drafts[0].draft, new RegExp(`${modelDirectory}/incoming/`));
    assert.deepEqual(routes, ['/chats']);
    capability = null;
    await assert.rejects(askStudioAgent(entry, version, chat, router, preview));
    assert.equal(drafts.length, 1);
  });
});
