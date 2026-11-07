import assert from 'node:assert/strict';
import test from 'node:test';

import { brokenEntrypointReferences, ENTRYPOINTS, referencesOf } from '../../tools/entrypointGraph.mts';

/**
 * Перезапуск GrigDesk читает граф целиком и сразу. Переименование модуля компилятор
 * ловит, а строковую ссылку — нет: путь subprocess, alias песочницы и `new URL`
 * остаются текстом, и такой промах виден только у человека, у которого сервер уже
 * не поднялся. Проверка идёт от точек входа, включая те, что подключаются обходом
 * каталога, — иначе выпавший исполнитель молча исчез бы из списка.
 */
test('граф зависимостей точек входа разрешается на диске', () => {
  assert.deepEqual(
    brokenEntrypointReferences().map(({ from, spec }) => `${from} → ${spec}`),
    [],
  );
});

test('все объявленные точки входа существуют', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const missing = ENTRYPOINTS.filter((path) => (
    !existsSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)))
  ));

  assert.deepEqual(missing, []);
});


/**
 * URL dot-segments обозначают каталог так же, как завершающий slash.
 * Модульные imports с тем же текстом остаются файловыми ссылками для проверки.
 */
test('URL на текущий/родительский каталог не становится файловым import', () => {
  const source = [
    "const parent = new URL('..', import.meta.url);",
    "const current = new URL('.', import.meta.url);",
    "const ancestor = new URL('../..', import.meta.url);",
    "const directory = new URL('../', import.meta.url);",
    "const resource = new URL('./kept.json', import.meta.url);",
    "import '..';",
    "import '../missing.mjs';",
  ].join('\n');

  assert.deepEqual(referencesOf(source).sort(), ['..', '../missing.mjs', './kept.json'].sort());
});

/**
 * MTS script пакета — самостоятельная точка входа, даже без обычного import из приложения.
 * Broken dependency такого script должна обнаруживаться тем же графом, что у TS entry.
 */
test('обход scripts DeepSeek включает MTS и обнаруживает отсутствующий импорт', async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'entrypoint-mts-'));
  const scripts = path.join(root, 'deepseek/scripts');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(scripts, { recursive: true });
  await fs.writeFile(path.join(scripts, 'build.mts'), "import './missing.ts';\n");

  const dependency = path.join(root, 'deepseek/node_modules/dependency/index.mjs');

  await fs.mkdir(path.dirname(dependency), { recursive: true });
  await fs.writeFile(dependency, 'const bundled = "import(\'./not-a-product-file.mjs\')";');
  await fs.appendFile(path.join(scripts, 'build.mts'), "import '../node_modules/dependency/index.mjs';\n");
  assert.deepEqual(brokenEntrypointReferences(root).filter((record) =>
    record.from.includes('node_modules')), []);

  assert.deepEqual(brokenEntrypointReferences(root).filter((record) =>
    record.from === 'deepseek/scripts/build.mts'), [{
    from: 'deepseek/scripts/build.mts', spec: './missing.ts',
  }]);

  await fs.rm(dependency);
  assert.ok(brokenEntrypointReferences(root).some((record) =>
    record.from === 'deepseek/scripts/build.mts' && record.spec === '../node_modules/dependency/index.mjs'));

});
