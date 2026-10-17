import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { ACTIVE_STATUSES, parseStudio3d } from '../../shared/studio3d/studio3dContracts.ts';
import * as catalog from '../../server/src/lib/tripo/catalog.ts';
import { MODEL_LIMIT, IMAGE_LIMIT } from '../../server/src/lib/studio3d/assetFormats.ts';
import { versionDto } from '../web/helpers/studio3d-fixtures.js';
import { TOOL_CATALOG } from '../../web/src/shared/tools/catalog.ts';
import { VIEWER_MEMORY } from '../../web/src/shared/viewer3d/resourcePolicy.ts';

const read = (name) => readFile(new URL(`../../docs/cockpit/${name}`, import.meta.url), 'utf8');

test('3D документы описывают док, сроки ожидания и действующий бюджет viewer', async () => {
  const tool = TOOL_CATALOG.find((item) => item.id === 'studio3d');
  const guide = await read('guide/studio3d.md');
  const window = await read('web/studio3d-window.md');
  const viewer = await read('web/studio3d-viewer.md');
  const jobs = await read('plugins/studio3d-jobs.md');

  assert.equal(tool.route, '/3d');
  assert.equal(tool.hotkey, 'Ctrl+Shift+Digit7');
  assert.match(guide, /инструмент правой рейки/);
  assert.match(guide, /Ctrl\+Shift\+7/);
  assert.match(window, /10 минут/);
  assert.match(jobs, /Не хватило средств в течение суток/);
  assert.match(viewer, new RegExp(`общий бюджет ${VIEWER_MEMORY / 1024 ** 2} МиБ`));

  for (const document of [guide, window, viewer, jobs]) {
    assert.doesNotMatch(document, /docs\/plans|\/home\//);
  }
});

test('Снимок миграции включает только действующие JS-проверки 3D', async () => {
  const baseline = JSON.parse(await readFile(new URL('../fixtures/migration-inventory-baseline.json',
    import.meta.url), 'utf8'));

  assert.equal(baseline.legacy.tests.includes('tests/web/studio3d-text.test.js'), true);
  assert.equal(baseline.legacy.tests.includes('tests/web/studio3d-tool-host.contract.test.js'), true);
  assert.equal(baseline.legacy.tests.includes('tests/web/studio3d-links.test.js'), false);
});

test('3D guide связывает ручной разбор и расходы с настоящими состояниями DTO', async () => {
  const guide = await read('guide/studio3d.md');
  const unknown = parseStudio3d.version(versionDto({
    status: 'unknown',
    cost: { ...versionDto().cost, state: 'unknown' }
  }));
  const closed = parseStudio3d.version({ ...unknown, status: 'unresolved' });

  assert.match(guide, /не повторяет оплату автоматически/);
  assert.match(guide, /в unresolved, освобождает локальные блокировки и сохраняет расходы/);
  assert.equal(ACTIVE_STATUSES.includes(unknown.status), true);
  assert.equal(ACTIVE_STATUSES.includes(closed.status), false);
  assert.equal(closed.cost.state, 'unknown');
  assert.match(guide, /«Скачать снова» не создаёт платный заказ/);
  assert.match(await read('plugins/README.md'), /guide\/studio3d\.md/);
});

test('Tripo docs фиксируют версии и цены действующего каталога', async () => {
  const api = await read('plugins/tripo-api.md');
  const versions = [
    catalog.MODEL_H,
    catalog.MODEL_P1,
    catalog.MODEL_P2,
    catalog.TEXTURE_V3,
    catalog.TEXTURE_V35,
    catalog.RIG_V1,
    catalog.RIG_V2,
    catalog.SEGMENT_V1,
    catalog.SEGMENT_V2
  ];

  for (const version of versions) {
    assert.ok(api.includes(`\`${version}\``), `Код и документ расходятся: ${version}`);
  }

  const check = catalog.tripoQuote('rig-check', {}, {});
  const convert = catalog.tripoQuote('export', { format: 'GLTF' }, {});

  assert.equal(check.total, 0);
  assert.equal(convert.total, 5);
  assert.match(api, /Rig-check бесплатен; экспорт базового формата — 5 кредитов/);
  assert.equal(catalog.USD_PER_CREDIT, 0.01);
  assert.match(api, /Кредит соответствует\s*\$0,01/);
});

test('Пределы upload и image pool в документах совпадают с кодом', async () => {
  const api = await read('plugins/tripo-api.md');
  const images = catalog.tripoPool('text-to-image', {});
  const modelMiB = MODEL_LIMIT / 1024 ** 2;
  const imageMiB = IMAGE_LIMIT / 1024 ** 2;

  assert.match(api, new RegExp(`Upload адаптера ограничен ${modelMiB} МиБ`));
  assert.match(api, new RegExp(`картинки — ${imageMiB} МиБ`));
  assert.equal(images.limit, 1);
  assert.match(api, /Пул картинок[^.]*одну задачу/);
});
