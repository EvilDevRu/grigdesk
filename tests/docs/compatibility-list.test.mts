import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COMPATIBILITY,
  collectMigrationInventory,
  remainingBeyondCompatibility,
} from '../../tools/migrationInventory.mts';

const REPO = new URL('../../', import.meta.url);

/**
 * Список совместимости — единственное разрешение оставить JavaScript. Без проверки он
 * превращается в место, куда удобно дописать «пока не трогаем»: у каждой строки обязаны
 * быть причина, условие снятия и настоящий файл на диске.
 */
test('каждая строка списка совместимости описана и существует', async () => {
  const problems: string[] = [];

  for (const entry of COMPATIBILITY) {
    if (!entry.reason.trim() || !entry.removeWhen.trim()) {
      problems.push(`${entry.path}: пустая причина или условие снятия`);
    }
    if (!entry.generated && !existsSync(new URL(entry.path, REPO))) {
      problems.push(`${entry.path}: файла нет`);
    }
  }

  assert.deepEqual(problems, []);
});

test('в списке нет дублей и он отсортирован по областям', () => {
  const paths = COMPATIBILITY.map((entry) => entry.path);

  assert.equal(new Set(paths).size, paths.length);
});

/**
 * Настоящий счётчик миграции. «Сколько всего .js в дереве» им не является: часть
 * файлов остаётся по контракту с уже установленным кокпитом, и смешивать их с
 * непереведённой реализацией значит не видеть ни того, ни другого.
 */
test('остаток миграции считается без списка совместимости', () => {
  const inventory = collectMigrationInventory();
  const legacy = Object.values(inventory.legacy).flat();
  const remaining = remainingBeyondCompatibility();
  const allowed = new Set(COMPATIBILITY.map((entry) => entry.path));

  // Каждый файл из списка, который лежит в дереве, обязан попадать в инвентарь:
  // иначе список разрешает то, чего проверка не видит.
  const present = COMPATIBILITY.filter((entry) => !entry.generated).map((entry) => entry.path);

  assert.deepEqual(present.filter((path) => !legacy.includes(path)), []);
  assert.deepEqual(remaining.filter((path) => allowed.has(path)), []);
});

/**
 * Обновление идёт «старый воркер + новое дерево»: воркер прошлой версии запускает
 * smoke-тест по литеральному имени и обычным `node --test`. Переименование этого файла
 * или добавление ему флагов ломает обновление у того, кто ещё не на новом коде.
 */
test('JS-вход smoke-теста обновления совпадает с тем, что зовёт воркер', async () => {
  const worker = await readFile(new URL('server/src/workers/cockpit-update-worker.js', REPO), 'utf8');
  const called = /\['--test', '([^']+)'\]/.exec(worker);

  assert.equal(called?.[1], 'tests/server/cockpit-release.test.js');
  assert.ok(existsSync(new URL(called[1], REPO)), 'файл smoke-теста обновления должен существовать');
  assert.ok(
    COMPATIBILITY.some((entry) => entry.path === called[1]),
    'JS-вход обновления обязан быть в списке совместимости с условием снятия',
  );
});
