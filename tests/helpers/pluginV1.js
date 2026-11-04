import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=',
  'base64',
);

export const expectedPackage = {
  version: '1.0.0',
  expectedId: null,
  reservedIds: new Set(['code']),
  grigDeskVersion: '1.0.0',
};

/**
 * Вход автора не содержит resolved URL и старых полей манифеста.
 * Каждый вызов возвращает независимые декларации для отрицательных мутаций.
 */
export function manifestV1(overrides = {}) {
  return {
    id: 'demo',
    api: 1,
    name: 'Демо',
    version: '1.0.0',
    description: 'Сервер и панель примера',
    icon: 'assets/icon.png',
    engines: { grigdesk: '>=0.0.0' },
    entrypoints: {
      server: 'runtime/main.ts',
      web: {
        dir: 'ui',
        entry: 'panel.js',
        css: ['panel.css'],
        locales: {}
      },
    },
    contributes: {
      panels: [{
        title: 'Панель',
        group: 'dock',
        order: 10
      }],
      slots: [{
        slot: 'provider.popover.after-bars',
        kind: 'provider-usage',
        default: true
      }],
      settings: [{
        key: 'limit',
        label: 'Лимит',
        type: 'number',
        default: 3
      }],
      commands: [],
      themes: [],
    },
    gallery: { screenshots: [] },
    install: { npm: [] },
    ...overrides,
  };
}

export const v1Files = {
  'assets/icon.png': png,
  'package.json': '{"type":"module"}',
  'runtime/value.ts': 'export const value: number = 42;',
  'runtime/main.ts': [
    "import { value } from './value.ts';",
    "const marker: string = await Promise.resolve('declared');",
    'export default async function plugin(app, options) {',
    '  app.get("/status", async () => ({',
    '    value, marker, core: options.core.project ? (await options.core.project("v1")).id : null,',
    '  }));',
    '}',
  ].join('\n'),
  'ui/panel.js': 'export default { render() { return null; } };',
  'ui/panel.css': 'body {}',
};

/**
 * Реальные файлы пакета создаются в одноразовом корне отдельно от данных владельца.
 * Уборка зарегистрирована до записи: неудачный assert не оставляет каталог.
 */
export async function packageV1(t, manifest = manifestV1(), files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-v1-'));
  const dir = path.join(root, manifest.id);

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [relative, body] of Object.entries({
    ...v1Files,
    ...files,
    'plugin.json': JSON.stringify(manifest),
  })) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), body);
  }

  return {
    root,
    dir,
    manifest
  };
}

/**
 * Legacy задан явно, чтобы будущая миграция общих положительных helper не дополнила его до v1.
 * Undefined перекрывает новые defaults до JSON.stringify: полей нет в записанном пакете.
 */
export function legacyManifest(overrides = {}) {
  return {
    api: 1,
    description: 'Старый пакет',
    icon: undefined,
    entrypoints: undefined,
    contributes: undefined,
    ...overrides,
  };
}
