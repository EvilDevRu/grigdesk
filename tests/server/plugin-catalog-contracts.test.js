import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeCatalogIndex, decodeCatalogDetail } from '../../shared/plugins/pluginCatalogContracts.ts';
import { catalogFixture } from '../helpers/pluginCatalog.js';

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
