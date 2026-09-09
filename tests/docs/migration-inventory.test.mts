import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectMigrationInventory,
  readMigrationBaseline,
  uncheckedTypeScript,
} from '../../tools/migrationInventory.mts';

const UPDATE_HINT = 'Остаток миграции изменился. Обнови снимок:'
  + ' node --experimental-strip-types tools/migrationInventory.ts --write';

/**
 * Рубеж переноса на TypeScript. Проверяется не «стало меньше», а точное совпадение
 * со снимком: пока миграция идёт, новый файл заводится по образцу соседнего, и без
 * этой сверки остаток рос бы ровно там, где его считают уменьшающимся. Убыль тоже
 * требует обновить снимок — тогда в diff видно, какие файлы закрыл заход.
 */
test('остаток собственного JavaScript совпадает со снимком миграции', () => {
  const inventory = collectMigrationInventory();
  const baseline = readMigrationBaseline();

  for (const area of new Set([...Object.keys(baseline.legacy), ...Object.keys(inventory.legacy)])) {
    assert.deepEqual(inventory.legacy[area] ?? [], baseline.legacy[area] ?? [], `${UPDATE_HINT} (${area})`);
  }
  assert.deepEqual(inventory.vue, baseline.vue, `${UPDATE_HINT} (vue)`);
});

test('снимок миграции не считает остатком чужой и собранный код', () => {
  const inventory = collectMigrationInventory();
  const all = [...Object.values(inventory.legacy).flat(), ...inventory.vue];

  assert.deepEqual(
    all.filter((path) => /(^|\/)(node_modules|dist|\.state|profiles)\//.test(path)),
    [],
  );
});

/**
 * Второй рубеж той же миграции: мало перевести файл на TypeScript — его должна
 * читать общая проверка среды. Файл вне проекта компилятор не открывает вовсе,
 * и зелёный typecheck о нём не говорит ничего.
 */
test('весь собственный TypeScript входит в общую проверку своей среды', () => {
  assert.deepEqual(
    uncheckedTypeScript(),
    [],
    'Файл не входит ни в server/tsconfig.json, ни в web/tsconfig.json:'
      + ' добавь его в include нужной среды либо в остаток миграции.',
  );
});

// Что в общем слое не должно появиться никогда: платформа одной стороны в модуле,
// который читают обе. Vue и Pinia привязали бы правило к браузеру, Fastify и
// файловая система — к серверу, а DOM-глобали просто не существуют в Node.
const FORBIDDEN_IN_SHARED = [
  /from\s+['"]vue['"]/,
  /from\s+['"]pinia['"]/,
  /from\s+['"]fastify['"]/,
  /from\s+['"]node:/,
  /\bdocument\./,
  /\bwindow\./,
  /\blocalStorage\b/,
];

/**
 * Общий слой обязан оставаться платформенно-независимым: правило, которое считают
 * и сервер, и браузер, не имеет права привезти с собой чужое окружение. Иначе
 * единственная копия правила снова разъедется на две — по одной на каждую сторону.
 */
test('общий слой не тянет за собой ни браузер, ни Node', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../../shared/', import.meta.url);
  const found: string[] = [];

  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ts')) {
      continue;
    }

    const source = await readFile(new URL(name, dir), 'utf8');

    for (const forbidden of FORBIDDEN_IN_SHARED) {
      if (forbidden.test(source)) {
        found.push(`shared/${name}: ${forbidden.source}`);
      }
    }
  }

  assert.deepEqual(found, []);
});
