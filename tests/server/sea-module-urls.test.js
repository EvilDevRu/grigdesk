import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createModuleUrlsPlugin, rewriteModuleImportMeta } from '../../server/scripts/sea/moduleUrls.mts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { build } = require('esbuild');

/**
 * Временное дерево фикстуры: два модуля в разных каталогах со своими ресурсами.
 * Уборка удаляет только этот каталог.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-module-urls-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Пишет файл вместе с каталогами; содержимое — простой UTF-8.
 */
async function put(root, file, text) {
  const target = path.join(root, file);

  await mkdir(path.dirname(target), {
    recursive: true
  });
  await writeFile(target, text);
}

/**
 * Готовит заглушку контракта путей: она подменяет runtimePaths в собранной фикстуре.
 * Реальный модуль проверяется своими тестами, здесь важна механика переписывания.
 */
async function runtimeStub(root) {
  const file = path.join(root, 'runtimeStub.mjs');

  await writeFile(file, [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    `const ROOT = ${JSON.stringify(root)};`,
    'export const moduleUrl = (relative) => pathToFileURL(path.join(ROOT, relative));',
    'export const moduleDirname = (relative) => path.dirname(path.join(ROOT, relative));',
    'export const moduleFilename = (relative) => path.join(ROOT, relative);',
    '',
  ].join('\n'));

  return file;
}

/**
 * Собирает фикстуру с плагином и возвращает текст результата.
 * Плагин получает настоящий esbuild, поэтому проверяется порядок onLoad и loader.
 */
async function bundle(root, entry, runtimeModule, extra = {}) {
  const outfile = path.join(root, 'out', 'bundle.mjs');
  const handle = createModuleUrlsPlugin({
    root,
    runtimeModule,
    ...extra,
  });

  await mkdir(path.dirname(outfile), {
    recursive: true
  });
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    plugins: [handle.plugin],
  });

  return {
    outfile,
    source: await readFile(outfile, 'utf8'),
    plugin: handle,
  };
}

/**
 * Размещает два независимых модуля с одинаковым именем ресурса.
 * Разные байты доказывают, что путь считается от файла, а не от одного define.
 */
async function twoModules(root) {
  await put(root, 'server/src/alpha/asset.txt', 'альфа');
  await put(root, 'server/src/beta/asset.txt', 'бета');
  await put(root, 'server/src/alpha/one.ts', [
    "import { readFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "export const alpha = readFileSync(fileURLToPath(new URL('./asset.txt', import.meta.url)), 'utf8');",
    'export const alphaDir = import.meta.dirname;',
    'export const alphaFile = import.meta.filename;',
    "export const alphaLiteral = 'import.meta.url';",
    '// import.meta.url в комментарии не переписывается',
    '',
  ].join('\n'));
  await put(root, 'server/src/beta/two.ts', [
    "import { readFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "export const beta = readFileSync(fileURLToPath(new URL('./asset.txt', import.meta.url)), 'utf8');",
    'export const betaDir = import.meta.dirname;',
    'export const betaFile = import.meta.filename;',
    '',
  ].join('\n'));
  await put(root, 'server/src/entry.ts', [
    "export { alpha, alphaDir, alphaFile, alphaLiteral } from './alpha/one.ts';",
    "export { beta, betaDir, betaFile } from './beta/two.ts';",
    '',
  ].join('\n'));
}

test('SEA-MU-01: два модуля получают свои URL, dirname и filename', async (t) => {
  const root = await fixture(t);

  await twoModules(root);

  const stub = await runtimeStub(root);
  const result = await bundle(root, 'server/src/entry.ts', stub);
  const loaded = await import(`${pathToFileURL(result.outfile).href}?t=${Date.now()}`);

  assert.equal(loaded.alpha, 'альфа');
  assert.equal(loaded.beta, 'бета');
  assert.equal(loaded.alphaDir, path.join(root, 'server/src/alpha'));
  assert.equal(loaded.betaDir, path.join(root, 'server/src/beta'));
  assert.equal(loaded.alphaFile, path.join(root, 'server/src/alpha/one.ts'));
  assert.equal(loaded.betaFile, path.join(root, 'server/src/beta/two.ts'));
  assert.equal(loaded.alphaLiteral, 'import.meta.url');
  assert.ok(result.plugin.transformed.includes(path.join(root, 'server/src/alpha/one.ts')));
  assert.ok(result.plugin.transformed.includes(path.join(root, 'server/src/beta/two.ts')));

  const rewritten = rewriteModuleImportMeta([
    "const literal = 'import.meta.url';",
    '// import.meta.url в комментарии',
    'const real = import.meta.url;',
    '',
  ].join('\n'), path.join(root, 'server/src/alpha/one.ts'), {
    root,
    runtimeModule: stub,
  });

  assert.match(rewritten.code, /'import\.meta\.url'/);
  assert.match(rewritten.code, /\/\/ import\.meta\.url/);
  assert.doesNotMatch(rewritten.code, /const real = import\.meta\.url/);
});

test('SEA-MU-02: неподдержанная форма import.meta отвергается явно', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/bad.ts', 'export const meta = import.meta;\n');

  const stub = await runtimeStub(root);

  await assert.rejects(
    bundle(root, 'server/src/bad.ts', stub),
    /import\.meta|неподдержанная/,
  );
});

test('SEA-MU-03: занятое имя помощника не ломает файл', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/asset.txt', 'ресурс');
  await put(root, 'server/src/name.ts', [
    "import { readFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const __seaModuleUrl = 1;',
    'void __seaModuleUrl;',
    "export const value = readFileSync(fileURLToPath(new URL('./asset.txt', import.meta.url)), 'utf8');",
    '',
  ].join('\n'));

  const stub = await runtimeStub(root);
  const result = await bundle(root, 'server/src/name.ts', stub);
  const loaded = await import(`${pathToFileURL(result.outfile).href}?t=${Date.now()}`);

  assert.equal(loaded.value, 'ресурс');
});

test('SEA-MU-04: файл контекста и явный skip не переписываются', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/context/runtimeBuildContext.ts', [
    "export const location = new URL('./asset.txt', import.meta.url);",
    '',
  ].join('\n'));
  await put(root, 'server/src/context/asset.txt', 'контекст');
  await put(root, 'server/src/generated/entry.mjs', [
    "export const entry = new URL('./asset.txt', import.meta.url);",
    '',
  ].join('\n'));
  await put(root, 'server/src/generated/asset.txt', 'вход');
  await put(root, 'server/src/imports.ts', [
    "export { location } from './context/runtimeBuildContext.ts';",
    "export { entry } from './generated/entry.mjs';",
    '',
  ].join('\n'));

  const stub = await runtimeStub(root);
  const generatedEntry = path.join(root, 'server/src/generated/entry.mjs');
  const result = await bundle(root, 'server/src/imports.ts', stub, {
    skip: [generatedEntry],
  });

  assert.ok(!result.plugin.transformed.includes(
    path.join(root, 'server/src/context/runtimeBuildContext.ts'),
  ));
  assert.ok(!result.plugin.transformed.includes(generatedEntry));
});

test('SEA-MU-05: node_modules и виртуальные файлы не переписываются', async (t) => {
  const root = await fixture(t);

  await put(root, 'node_modules/fake/index.js', 'export const meta = import.meta.url;\n');
  await put(root, 'server/src/imports.ts', "export { meta } from 'fake';\n");

  const stub = await runtimeStub(root);
  const result = await bundle(root, 'server/src/imports.ts', stub);

  assert.deepEqual(result.plugin.transformed.filter((file) => file.includes('node_modules')), []);
});

test('SEA-MU-06: модуль вне корня отвергается, а не получает относительный путь', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);

  await put(outside, 'module.ts', "export const url = import.meta.url;\n");

  const stub = await runtimeStub(root);

  await assert.rejects(
    bundle(root, path.relative(root, path.join(outside, 'module.ts')), stub),
    /вне корня|вне дерева/,
  );
});
