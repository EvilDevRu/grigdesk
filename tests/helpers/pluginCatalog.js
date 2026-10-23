/**
 * Каталог и Git SHA синтетические; fixture не обращается к сети или данным владельца.
 * Один источник используется индексом, detail и проверками установленного пакета.
 */
export function catalogFixture() {
  const date = '2026-10-22T10:00:00.000Z';
  const version = {
    version: '1.1.0',
    tag: 'v1.1.0',
    sha: 'a'.repeat(40),
    api: 1,
    minGrigDeskVersion: '1.0.0',
  };
  const entry = {
    id: 'demo',
    repository: 'example/demo',
    origin: 'community',
    category: 'dev',
    summary: { ru: 'Пример плагина', en: 'Example plugin' },
    name: 'Demo',
    source: { kind: 'git', url: 'https://github.com/example/demo.git' },
    license: 'MIT',
    archived: false,
    checkedAt: date,
  };
  const index = {
    schemaVersion: 1,
    generatedAt: date,
    plugins: [{
      ...entry,
      latest: version,
      details: 'demo.json'
    }],
  };
  const detail = {
    schemaVersion: 1,
    generatedAt: date,
    plugin: {
      ...entry,
      description: 'Example description',
      versions: [version],
      readme: '<script>throw new Error("untrusted")</script>\nExample README',
      releaseNotes: 'Example changes',
    },
  };

  return {
    index: structuredClone(index),
    detail: structuredClone(detail),
    version: structuredClone(version),
    entry: structuredClone(entry),
  };
}
