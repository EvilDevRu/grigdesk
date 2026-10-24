import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { importRuntimeModule } from '../../server/src/lib/runtimeImport.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BRIDGE_TEMPLATE = path.join(ROOT, 'server/build/esmBridge.cjs');

/**
 * Временная папка теста; уборка удаляет только собственный каталог.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-runtime-import-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Готовит ESM-плагин с относительным импортом и top-level await.
 * Имя каталога содержит пробел: путь обязан переживать file URL.
 */
async function pluginFixture(root, extension = 'js') {
  const directory = path.join(root, 'plugins', 'demo plugin');

  await mkdir(path.join(directory, 'lib'), {
    recursive: true
  });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'demo-plugin',
    type: 'module',
  }));
  await writeFile(path.join(directory, `lib/value.${extension}`),
    `export const value${extension === 'ts' ? ': string' : ''} = 'из соседнего файла';\n`);
  await writeFile(path.join(directory, `server.${extension}`), [
    `import { value } from './lib/value.${extension}';`,
    '',
    `const marker${extension === 'ts' ? ': string' : ''} = await Promise.resolve('relative-import+tla');`,
    '',
    'export default async function plugin(app) {',
    '  app.get("/demo", async () => ({ value, marker }));',
    "  return 'cleanup-called';",
    '}',
    '',
  ].join('\n'));

  return {
    directory,
    server: path.join(directory, `server.${extension}`)
  };
}

/**
 * Создаёт минимум упакованного R: package.json для createRequire и внешний bridge.
 * Копия bridge — ровно тот шаблон, который сборщик положит в комплект.
 */
async function packagedRoot(root, { bridge = true } = {}) {
  const R = path.join(root, 'R with space');

  await mkdir(path.join(R, 'server/runtime'), {
    recursive: true
  });
  await writeFile(path.join(R, 'server/package.json'), '{ "name": "fixture", "type": "module" }\n');

  if (bridge) {
    await writeFile(path.join(R, 'server/runtime/esmBridge.cjs'), await readFile(BRIDGE_TEMPLATE));
  }

  return R;
}

/**
 * Приложение-заглушка: сохраняет зарегистрированный маршрут и его ответ.
 */
function fakeApp() {
  const app = {
    route: null,
    get(url, handler) {
      this.route = {
        url,
        handler
      };
    },
  };

  return app;
}

test('SEA-PLUG-01: source грузит внешний ESM с относительным импортом и TLA', async (t) => {
  const root = await scratch(t);
  const plugin = await pluginFixture(root);
  const module = await importRuntimeModule(plugin.server);
  const app = fakeApp();

  assert.equal(typeof module.default, 'function');
  assert.equal(await module.default(app), 'cleanup-called');
  assert.equal(app.route.url, '/demo');
  assert.deepEqual(await app.route.handler(), {
    value: 'из соседнего файла',
    marker: 'relative-import+tla',
  });
});

test('SEA-PLUG-02: packaged грузит плагин через внешний bridge комплекта', async (t) => {
  const root = await scratch(t);
  const plugin = await pluginFixture(root);
  const R = await packagedRoot(root);
  const module = await importRuntimeModule(plugin.server, {
    kind: 'packaged',
    root: R,
  });
  const app = fakeApp();

  assert.equal(typeof module.default, 'function');
  await module.default(app);
  assert.equal(app.route.url, '/demo');
  assert.deepEqual(await app.route.handler(), {
    value: 'из соседнего файла',
    marker: 'relative-import+tla',
  });
});

test('SEA-PLUG-03: отсутствующий bridge — отказ с путём, без fallback на source', async (t) => {
  const root = await scratch(t);
  const plugin = await pluginFixture(root);
  const R = await packagedRoot(root, {
    bridge: false
  });

  await assert.rejects(importRuntimeModule(plugin.server, {
    kind: 'packaged',
    root: R,
  }), (error) => {
    assert.match(error.message, /esmBridge\.cjs/);
    assert.ok(error.message.includes(path.join(R, 'server/runtime/esmBridge.cjs')));

    return true;
  });
});

test('SEA-PLUG-04: шаблон bridge — обычный import(url), без eval и патчинга', async () => {
  const source = await readFile(BRIDGE_TEMPLATE, 'utf8');

  assert.match(source, /module\.exports\.importUrl = \(url\) => import\(url\);/);
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /\bFunction\s*\(/);
});

test('SEA-PLUG-05: новый bare или вычисляемый import не остаётся в SEA незаметно', async () => {
  const manifest = JSON.parse(await readFile(
    path.join(ROOT, 'server/build/sea-inventory.json'),
    'utf8',
  ));
  const allowedComputed = new Set([
    'server/src/lib/runtimeImport.ts',
    'server/src/lib/executors/registryTable.ts',
    'server/src/lib/db/engineDirectory.ts',
  ]);
  const points = manifest.points.filter((point) => point.construct === 'dynamic-import');
  const pluginModule = points.filter((point) => point.file === 'server/src/modules/plugins/index.ts');

  assert.deepEqual(pluginModule, []);

  for (const point of points) {
    if (point.target === '<computed>') {
      if (point.fate === 'server-bundle') {
        assert.ok(allowedComputed.has(point.file),
          `вычисляемый import в SEA-бандле без файлового loader-а: ${point.file}`);
      }

      continue;
    }

    const bare = !point.target.startsWith('.') && !point.target.startsWith('node:')
      && !point.target.startsWith('file:');

    if (bare && point.fate === 'server-bundle') {
      assert.fail(`bare import ${point.target} в ${point.file} не может остаться в SEA`);
    }
  }

  assert.ok(points.some((point) => point.file === 'server/src/lib/runtimeImport.ts'
    && point.target === '<computed>'));
});

for (const packaged of [false, true]) {
  test(`NTS-0${packaged ? 2 : 1}: native TS, относительный import и TLA, bridge=${packaged}`, async (t) => {
    const root = await scratch(t);
    const plugin = await pluginFixture(root, 'ts');
    const runtime = packaged ? { kind: 'packaged', root: await packagedRoot(root) } : undefined;
    const module = await importRuntimeModule(plugin.server, runtime);
    const app = fakeApp();

    await module.default(app);
    assert.equal(app.route.url, '/demo');
    assert.deepEqual(await app.route.handler(), {
      value: 'из соседнего файла',
      marker: 'relative-import+tla',
    });
  });
}
