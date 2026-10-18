import assert from 'node:assert/strict';
import test from 'node:test';

import { brokenEntrypointReferences, ENTRYPOINTS } from '../../tools/entrypointGraph.mts';

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
