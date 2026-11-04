process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';
import { extendedMetrics, oldMetrics } from './helpers/computer-resources-fixtures.js';

let browser;
let mount;
let flushPromises;
let ResourcesDialog;

before(async () => {
  browser = await createUiBrowser();

  const [utils, component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/shared/layout/ComputerResourcesDialog.vue')),
  ]);

  ({ mount, flushPromises } = utils);
  ResourcesDialog = component;
});

after(async () => browser.close());

test('RESOURCES: единый диалог сохраняет устройства, предупреждения и прокрутку', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';
  browser.happyDOM.setWindowSize({ width: 390, height: 844 });

  const metrics = extendedMetrics();

  metrics.disks[0].freeGb = 4.1;

  const wrapper = mount(ResourcesDialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      open: true,
      metrics,
      stale: true,
      snapshotTime: '12:34',
    },
    global: { stubs: { transition: false } },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  const dialog = browser.document.querySelector('[data-role="system-resources"]');
  const panel = dialog.querySelector('.computer-resources');
  const rows = [...panel.querySelectorAll('.pu-row')];

  assert.equal(dialog.getAttribute('aria-label'), 'Ресурсы компьютера');
  assert.equal(dialog.querySelectorAll('.ui-dialog__header').length, 1);
  assert.equal(dialog.querySelectorAll('button').length, 1);
  assert.equal(dialog.querySelectorAll('.ui-popover').length, 0);
  assert.equal(rows.length, 7);
  assert.match(panel.querySelector('[role="status"]').textContent, /12:34/u);
  assert.equal(browser.document.activeElement === panel, true);

  const disk = rows.find((row) => row.textContent.includes('/data/first'));
  const gpu = rows.find((row) => row.textContent.includes('Fixture RTX 3070'));

  assert.match(disk.textContent, /4,1/u);
  assert.equal(disk.querySelector('.pu-fill').classList.contains('lv-bad'), true);
  assert.match(disk.textContent, /диск данных GrigDesk/u);
  assert.match(gpu.textContent, /24%/u);
  assert.match(gpu.textContent, /53 °C/u);
  assert.match(gpu.textContent, /1,5 из 8/u);
  assert.doesNotMatch(gpu.textContent, /61 °C|41 °C/u);

  const style = browser.document.createElement('style');
  const files = ['tokens', 'base', 'components/foundation', 'components/actions', 'components/overlays'];
  const source = await readFile(webFile('src/shared/layout/ComputerResourcesPanel.vue'), 'utf8');
  const cssText = (await Promise.all(files.map((name) =>
    readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n')
    + '\n' + source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];

  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());
  assert.equal(browser.getComputedStyle(dialog).height, '100%');
  assert.equal(browser.getComputedStyle(dialog.querySelector('.ui-dialog__body')).overflow, 'hidden');
  assert.equal(browser.getComputedStyle(panel).overflow, 'auto');

});

test('RESOURCES: загрузка, старый сервер и неизвестная нагрузка сохраняют честные значения', async (t) => {
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const wrapper = mount(ResourcesDialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      open: true,
      metrics: null,
      stale: false,
      snapshotTime: '',
    },
    global: { stubs: { transition: false } },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();
  assert.equal(Boolean(browser.document.querySelector('.computer-resources')), false);
  await wrapper.setProps({ metrics: oldMetrics() });
  await flushPromises();

  let panel = browser.document.querySelector('.computer-resources');

  assert.equal(panel.querySelectorAll('.pu-row').length, 3);
  assert.match(panel.textContent, /Оперативная память.*75%/u);
  assert.match(panel.textContent, /Подкачка.*50%/u);

  const metrics = oldMetrics();

  delete metrics.cpu.load1;
  metrics.gpus = [{ id: 'unknown', name: 'Unknown GPU' }];
  metrics.mem = {
    totalGb: 16,
    usedGb: 4,
    percent: 25,
  };
  await wrapper.setProps({ metrics });
  await flushPromises();
  panel = browser.document.querySelector('.computer-resources');

  const gpu = [...panel.querySelectorAll('.pu-row')].find((row) => row.textContent.includes('Unknown GPU'));

  assert.match(gpu.textContent, /—/u);
  assert.equal(gpu.querySelector('.pu-fill').style.width, '0%');
  assert.match(panel.textContent, /подкачка выключена/u);
  assert.doesNotMatch(panel.textContent, /NaN|undefined/u);
});
