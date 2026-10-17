process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile, singletonUrl } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('WV-03/07 controls, compare, snapshot и dispose через engine port', async (t) => {
  await installUiBrowser(t);
  
  const { nextTick } = await import(singletonUrl('vue'));
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  const calls = [];
  const engines = [];
  
  globalThis.ResizeObserver = class { observe() {} disconnect() {
    calls.push(['disconnect']);
  } };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  
  const info = {
    stats: { triangles: 12, bones: 1 },
    clips: [{ name: 'Шаг', duration: 2 }],
    parts: ['Тело']
  };
  
  globalThis.__studioViewer = { create: () => {
    const index = engines.length;
    const engine = Object.fromEntries(['setMode', 'showBones', 'showParts', 'setBackground', 'setLight',
      'playClip', 'setTime', 'setSpeed', 'fitView', 'resize', 'dispose', 'syncCamera', 'setVisible']
      .map((method) => [method, (...args) => calls.push([index, method, ...args])]));
    
    engine.load = async (...args) => {
      calls.push([index, 'load', ...args]);
      
      return info;
    };
    engine.snapshot = async () => new Blob(['snapshot'], { type: 'image/webp' });
    engine.onCameraChange = () => () => {};
    engine.onTimeChange = () => () => {};
    engines.push(engine);
    
    return engine;
  } };
  
  const Viewer = await compileVue(webFile('src/shared/viewer3d/ModelViewer.vue'), { stubs: {
    './viewerEngine.ts': 'export const loadEngine=async()=>globalThis.__studioViewer.create;',
  } });
  const wrapper = mount(Viewer, { props: {
    src: '/api/studio3d/files/m/v/model.glb',
    ext: 'glb',
    compareSrc: '/api/studio3d/files/m/other/model.glb',
    compareExt: 'glb'
  } });
  
  await new Promise(setImmediate);
  await nextTick();
  assert.equal(calls.filter((call) => call[1] === 'load').length, 2);
  await wrapper.get('[data-context="studio-view-mode"] button:nth-child(3)').trigger('click');
  assert.equal(calls.some((call) => call[1] === 'setMode' && call[2] === 'wire'), true);

  const settings = wrapper.get('[aria-label="Настройки вида"]');

  assert.equal(settings.attributes('aria-expanded'), 'false');
  await settings.trigger('click');
  assert.equal(settings.attributes('aria-expanded'), 'true');
  await wrapper.get('[data-context="studio-bones"]').setValue(true);
  assert.equal(calls.some((call) => call[1] === 'showBones' && call[2]), true);
  await wrapper.get('[aria-label="Фон"]').setValue('light');
  await wrapper.get('[aria-label="Свет"]').setValue('flat');
  assert.equal(calls.some((call) => call[1] === 'setBackground' && call[2] === 'light'), true);
  assert.equal(calls.some((call) => call[1] === 'setLight' && call[2] === 'flat'), true);
  await settings.trigger('click');
  assert.equal(settings.attributes('aria-expanded'), 'false');
  await wrapper.get('[data-context="studio-clip"]').setValue('Шаг');
  assert.equal(calls.some((call) => call[1] === 'playClip' && call[2] === 'Шаг'), true);
  wrapper.element.requestFullscreen = async () => {
    throw new Error('Запрещено браузером');
  };
  await wrapper.get('[aria-label="Во весь экран"]').trigger('click');
  await new Promise(setImmediate);
  assert.match(wrapper.text(), /Полноэкранный режим недоступен/);
  assert.equal(wrapper.emitted('error'), undefined);
  engines[1].load = async () => {
    throw new Error('Сравнение недоступно');
  };
  await wrapper.setProps({ compareSrc: '/api/studio3d/files/m/broken/model.glb' });
  await new Promise(setImmediate);
  await nextTick();
  assert.equal(calls.some((call) => call[0] === 0 && call[1] === 'dispose'), false);
  await wrapper.get('[aria-label="Снимок"]').trigger('click');
  await new Promise(setImmediate);
  assert.equal(wrapper.emitted('snapshot')[0][0].type, 'image/webp');
  wrapper.unmount();
  assert.equal(calls.filter((call) => call[1] === 'dispose').length, 2);
  assert.equal(calls.some((call) => call[0] === 'disconnect'), true);
});

test('WV-07 поздние load/snapshot не публикуются и ошибка имеет download fallback', async (t) => {
  await installUiBrowser(t);

  const { nextTick } = await import(singletonUrl('vue'));
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  const loads = [];
  let finishSnapshot;
  let closed = 0;

  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  globalThis.__studioViewer = { create: () => ({
    ...Object.fromEntries(['setMode', 'showBones', 'showParts', 'setBackground', 'setLight',
      'playClip', 'setTime', 'setSpeed', 'fitView', 'resize', 'syncCamera',
        'setVisible'].map((key) => [key, () => {}])),
    load: () => new Promise((resolve, reject) => loads.push({ resolve, reject })),
    snapshot: () => new Promise((resolve) => {
      finishSnapshot = resolve;
    }),
    dispose: () => {
      closed += 1;
    },
    onCameraChange: () => () => {},
    onTimeChange: () => () => {},
  }) };

  const Viewer = await compileVue(webFile('src/shared/viewer3d/ModelViewer.vue'), { stubs: {
    './viewerEngine.ts': 'export const loadEngine=async()=>globalThis.__studioViewer.create;',
  } });
  const wrapper = mount(Viewer, { props: { src: '/api/studio3d/files/m/a/model.glb', ext: 'glb' } });

  t.after(() => wrapper.unmount());
  await new Promise(setImmediate);
  await wrapper.setProps({ src: '/api/studio3d/files/m/b/model.glb' });
  await new Promise(setImmediate);
  loads[1].resolve({
    stats: {},
    clips: [],
    parts: ['Новая']
  });
  await new Promise(setImmediate);
  loads[0].resolve({
    stats: {},
    clips: [],
    parts: ['Старая']
  });
  await new Promise(setImmediate);
  assert.equal(wrapper.emitted('loaded').length, 1);
  assert.deepEqual(wrapper.emitted('loaded')[0][0].parts, ['Новая']);
  await wrapper.get('[aria-label="Снимок"]').trigger('click');
  await wrapper.setProps({ src: '/api/studio3d/files/m/c/model.glb' });
  await new Promise(setImmediate);
  finishSnapshot(new Blob(['old'], { type: 'image/webp' }));
  loads[2].reject(new Error('Повреждённый файл'));
  await new Promise(setImmediate);
  await nextTick();
  assert.equal(wrapper.emitted('snapshot'), undefined);
  assert.match(wrapper.text(), /Не удалось показать модель: Повреждённый файл/);
  assert.equal(wrapper.find('a[download]').attributes('href'), '/api/studio3d/files/m/c/model.glb');
  assert.equal(closed, 1);
});
