import { catalogFixture } from './pluginCatalog.js';

/**
 * Единый каталог содержит новый api2 релиз и прежний api1 релиз одного ID.
 * Отдельная api1 карточка проверяет смешанную выдачу без выбора канала.
 */
export function moduleCatalogFixture() {
  const data = catalogFixture();
  const next = {
    ...data.version,
    version: '2.0.0',
    tag: 'v2.0.0',
    sha: 'b'.repeat(40),
    api: 2,
  };
  const ordinary = structuredClone(data.index.plugins[0]);

  ordinary.id = 'ordinary';
  ordinary.repository = 'example/ordinary';
  ordinary.source.url = 'https://github.com/example/ordinary.git';
  ordinary.details = 'ordinary.json';
  data.index.plugins[0].latest = next;
  data.index.plugins.push(ordinary);
  data.detail.plugin.versions.unshift(next);
  data.version = next;

  return data;
}

/**
 * Локальная HTTP-оболочка отражает принятый index без обхода строгого parser.
 * Время ответа берётся из той же синтетической выдачи, что и содержимое каталога.
 */
export function catalogResponse(data) {
  return {
    state: 'fresh',
    applicationVersion: '1.0.0',
    fetchedAt: data.index.generatedAt,
    catalog: data.index,
  };
}
