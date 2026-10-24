import { catalogFixture } from './pluginCatalog.js';

/**
 * Оба канала сохраняют старый api1 релиз одного ID, modern добавляет старший api2.
 * В индексе modern также остаётся api1 карточка, чтобы проверять смешанную выдачу.
 */
export function moduleCatalogFixture() {
  const legacy = catalogFixture();
  const modern = structuredClone(legacy);
  const next = {
    ...legacy.version,
    version: '2.0.0',
    tag: 'v2.0.0',
    sha: 'b'.repeat(40),
    api: 2,
  };
  const ordinary = structuredClone(legacy.index.plugins[0]);

  ordinary.id = 'ordinary';
  ordinary.repository = 'example/ordinary';
  ordinary.source.url = 'https://github.com/example/ordinary.git';
  ordinary.details = 'ordinary.json';
  modern.index.plugins[0].latest = next;
  modern.index.plugins.push(ordinary);
  modern.detail.plugin.versions.unshift(next);
  modern.version = next;

  return { legacy, modern };
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
