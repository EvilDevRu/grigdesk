// Документы Tripo сверяются с настоящим клиентом и каталогом; продуктовые проверки принадлежат плагину.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import * as catalog from '../../server/src/lib/tripo/catalog.ts';
import { UPLOAD_MAX_BYTES, IMAGE_MAX_BYTES } from '../../server/src/lib/tripo/client.ts';

const read = (name) => readFile(new URL(`../../docs/grigdesk/${name}`, import.meta.url), 'utf8');

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
  const modelMiB = UPLOAD_MAX_BYTES / 1024 ** 2;
  const imageMiB = IMAGE_MAX_BYTES / 1024 ** 2;

  assert.match(api, new RegExp(`Upload адаптера ограничен ${modelMiB} МиБ`));
  assert.match(api, new RegExp(`картинки — ${imageMiB} МиБ`));
  assert.equal(images.limit, 1);
  assert.match(api, /Пул картинок[^.]*одну задачу/);
});
