import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeCatalogIndex, decodeCatalogDetail, decodeCatalogResponse,
} from '../../shared/plugins/pluginCatalogContracts.ts';
import { catalogFixture } from '../helpers/pluginCatalog.js';
import { moduleCatalogFixture, catalogResponse } from '../helpers/pluginCatalogModules.js';

test('CAT-D1: v1, пустой начальный индекс, safe projection и полные детали', () => {
  const fixture = catalogFixture();

  assert.deepEqual(decodeCatalogIndex({
    schemaVersion: 1,
    generatedAt: null,
    plugins: []
  }), {
    schemaVersion: 1,
    generatedAt: null,
    plugins: [],
  });
  assert.deepEqual(decodeCatalogIndex({ ...fixture.index, privateField: 'drop' }), fixture.index);
  assert.deepEqual(decodeCatalogDetail(fixture.detail), fixture.detail);
  assert.notStrictEqual(fixture.index.plugins[0].latest, fixture.detail.plugin.versions[0]);
});

test('CAT-D2: повреждённый элемент не публикует частичный индекс', () => {
  const fixture = catalogFixture();
  const mutations = [
    (value) => {
      value.schemaVersion = 2;
    },
    (value) => {
      value.generatedAt = null;
    },
    (value) => {
      value.plugins.push(structuredClone(value.plugins[0]));
    },
    (value) => {
      value.plugins[0].id = 'constructor';
    },
    (value) => {
      value.plugins[0].details = '../demo.json';
    },
    (value) => {
      value.plugins[0].details = 'https://other.invalid/demo.json';
    },
    (value) => {
      value.plugins[0].source.url = 'https://github.com/other/demo.git';
    },
    (value) => {
      value.plugins[0].checkedAt = '2026-02-31T00:00:00.000Z';
    },
    (value) => {
      value.plugins[0].latest.sha = 'a'.repeat(7);
    },
    (value) => {
      value.plugins[0].latest.tag = 'v9.9.9';
    },
    (value) => {
      value.plugins[0].summary.en = null;
    },
  ];

  for (const mutate of mutations) {
    const input = structuredClone(fixture.index);

    mutate(input);
    assert.throws(() => decodeCatalogIndex(input), /Каталог/u);
  }

  const detail = structuredClone(fixture.detail);

  detail.plugin.versions.push(structuredClone(detail.plugin.versions[0]));
  assert.throws(() => decodeCatalogDetail(detail), /Каталог/u);
});


test('CAT-D3-MIXED: единый v1 принимает api1 и api2 без выбора режима', () => {
  const data = moduleCatalogFixture();
  const response = catalogResponse(data);

  assert.deepEqual(decodeCatalogIndex(data.index), data.index);
  assert.deepEqual(decodeCatalogDetail(data.detail), data.detail);
  assert.deepEqual(decodeCatalogResponse(response), response);
});

test('CAT-D3-STRICT-BARRIER: смешанный каталог сохраняет проверку api, SHA, identity и оболочки', () => {
  const fixture = moduleCatalogFixture();
  const mutations = [
    (data) => {
      data.index.plugins[0].latest.api = 3;
      data.detail.plugin.versions[0].api = 3;
    },
    (data) => {
      data.index.plugins[0].latest.sha = 'bad';
      data.detail.plugin.versions[0].sha = 'bad';
    },
    (data) => {
      data.index.plugins[0].source.url = 'https://github.com/other/demo.git';
      data.detail.plugin.source.url = 'https://github.com/other/demo.git';
    },
  ];

  for (const mutate of mutations) {
    const data = structuredClone(fixture);

    mutate(data);
    assert.throws(() => decodeCatalogIndex(data.index), /Каталог/u);
    assert.throws(() => decodeCatalogDetail(data.detail), /Каталог/u);
    assert.throws(() => decodeCatalogResponse(catalogResponse(data)), /Каталог/u);
  }

  assert.throws(() => decodeCatalogResponse({ ...catalogResponse(fixture), state: 'unavailable' }),
    /Каталог/u);
});
