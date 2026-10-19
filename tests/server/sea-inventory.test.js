import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONSTRUCTS,
  FATES,
  checkInventory,
  compareInventory,
  scanProject,
} from '../../server/scripts/sea/inventory.mts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = path.join(ROOT, 'server/build/sea-inventory.json');

/**
 * Создаёт отдельное временное дерево-фикстуру для сканера.
 * Уборка привязана к тесту и удаляет только собственный каталог.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-inventory-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Пишет файл фикстуры вместе с недостающими каталогами.
 * Содержимое остаётся простым текстом: сканер не запускает проверяемые файлы.
 */
async function put(root, file, text) {
  const target = path.join(root, file);

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

/**
 * Собирает запись таблицы с заполненными владельцем и судьбой.
 * Тестам важен только контракт сравнения, а не реальная классификация.
 */
function record(file, construct, target, count = 1, extra = {}) {
  return {
    file,
    construct,
    target,
    count,
    owner: 'task-0',
    fate: 'server-bundle',
    detail: 'фикстура',
    ...extra
  };
}

/**
 * Проверяет, что ожидаемый отказ действительно назван среди ошибок проверки.
 * Сообщение ищется по фрагменту, чтобы тест не зависел от полной формулировки.
 */
function assertError(errors, fragment) {
  assert.ok(
    errors.some((error) => error.includes(fragment)),
    `нет отказа «${fragment}» среди:\n${errors.join('\n')}`,
  );
}

test('SEA-INV-01: таблица покрывает все точки упаковки текущего дерева', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const errors = await checkInventory(ROOT, manifest);

  assert.deepEqual(errors, []);

  const constructs = new Set(manifest.points.map((point) => point.construct));

  for (const construct of ['exec-path', 'fork', 'import-meta', 'dynamic-import',
    'create-require', 'require-resolve', 'resource-ref', 'shell-ref']) {
    assert.ok(constructs.has(construct), `в таблице нет конструкции ${construct}`);
  }

  const paths = new Set(manifest.resources.map((resource) => resource.path));

  for (const required of ['VERSION', 'server/seed/', 'server/requirements-media.txt',
    'server/package.json', 'server/package-lock.json']) {
    assert.ok(paths.has(required), `в таблице нет ресурса ${required}`);
  }
});

test('SEA-INV-02: новый fork и вычисляемый import не проходят мимо таблицы', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/a.ts', [
    "import { fork } from 'node:child_process';",
    '',
    'const first = fork(worker);',
    'const second = fork(worker);',
    'const mod = await import(target);',
    '',
  ].join('\n'));

  const scanned = await scanProject(root);
  const fork = scanned.filter((point) => point.construct === 'fork');
  const dynamic = scanned.filter((point) => point.construct === 'dynamic-import');

  assert.equal(fork.length, 1);
  assert.equal(fork[0].count, 2);
  assert.equal(dynamic.length, 1);
  assert.equal(dynamic[0].target, '<computed>');

  const empty = {
    schema: 1,
    points: [],
    resources: []
  };
  const errors = await checkInventory(root, empty);

  assertError(errors, 'server/src/a.ts');
  assertError(errors, 'fork');
  assertError(errors, 'dynamic-import');

  const partial = {
    schema: 1,
    points: [record('server/src/a.ts', 'fork', '', 1)],
    resources: []
  };
  const countErrors = await checkInventory(root, partial);

  assertError(countErrors, 'Число точек');

  const accounted = {
    schema: 1,
    points: [
      record('server/src/a.ts', 'fork', '', 2),
      record('server/src/a.ts', 'dynamic-import', '<computed>'),
    ],
    resources: []
  };

  assert.deepEqual(await checkInventory(root, accounted), []);
});

test('SEA-INV-03: удалённая точка не остаётся незаметным мусором таблицы', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/b.ts', 'const value = 1;\n');

  const manifest = {
    schema: 1,
    points: [record('server/src/b.ts', 'fork', '')],
    resources: []
  };
  const errors = await checkInventory(root, manifest);

  assertError(errors, 'устарела');
  assertError(errors, 'server/src/b.ts');

  const removedFile = {
    schema: 1,
    points: [record('server/src/gone.ts', 'exec-path', '')],
    resources: []
  };

  assertError(await checkInventory(root, removedFile), 'устарела');
});

test('SEA-INV-04: ссылка на ресурс требует файл и запись payload', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/c.ts', [
    "const helper = fileURLToPath(new URL('./asset.py', import.meta.url));",
    '',
  ].join('\n'));
  await put(root, 'server/src/asset.py', 'print(1)\n');

  const points = [
    record('server/src/c.ts', 'import-meta', 'url'),
    record('server/src/c.ts', 'resource-ref', 'server/src/asset.py', 1, {
      fate: 'asset',
    }),
  ];
  const withoutPayload = {
    schema: 1,
    points,
    resources: []
  };

  assertError(await checkInventory(root, withoutPayload), 'не покрыта payload');

  const withPayload = {
    schema: 1,
    points,
    resources: [{
      path: 'server/src/asset.py',
      kind: 'file',
      expect: 'source',
      owner: 'task-0',
      fate: 'asset',
      detail: 'фикстура',
    }],
  };

  assert.deepEqual(await checkInventory(root, withPayload), []);

  await rm(path.join(root, 'server/src/asset.py'));

  assertError(await checkInventory(root, withPayload), 'не существует');
});

test('SEA-INV-05: shell-ссылки учитываются отдельно от комментариев', async (t) => {
  const root = await fixture(t);

  await put(root, 'engine/run.sh', [
    '#!/usr/bin/env bash',
    '# Комментарий: server/src/comment-only.ts не является ссылкой.',
    'node "$ROOT/server/src/app.ts"',
    '',
  ].join('\n'));

  const scanned = await scanProject(root);
  const shell = scanned.filter((point) => point.construct === 'shell-ref');

  assert.equal(shell.length, 1);
  assert.equal(shell[0].file, 'engine/run.sh');
  assert.equal(shell[0].target, 'server/src/app.ts');

  const manifest = {
    schema: 1,
    points: [record('engine/run.sh', 'shell-ref', 'server/src/comment-only.ts', 1, {
      fate: 'compat-wrapper',
    })],
    resources: []
  };

  assertError(await checkInventory(root, manifest), 'устарела');
});

test('SEA-INV-06: схема отвергает незаполненные и неизвестные значения', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/d.ts', 'const pid = process.execPath;\n');

  const unassigned = {
    schema: 1,
    points: [record('server/src/d.ts', 'exec-path', '', 1, {
      owner: 'unassigned',
      fate: 'unassigned',
    })],
    resources: []
  };
  const errors = await checkInventory(root, unassigned);

  assertError(errors, 'владелец не назначен');
  assertError(errors, 'судьба не назначена');

  const unknown = {
    schema: 1,
    points: [record('server/src/d.ts', 'exec-path', '', 1, {
      owner: 'task-99',
      fate: 'teleport',
    })],
    resources: []
  };
  const unknownErrors = await checkInventory(root, unknown);

  assertError(unknownErrors, 'неизвестный владелец');
  assertError(unknownErrors, 'неизвестная судьба');

  assert.ok(CONSTRUCTS.includes('shell-ref'));
  assert.ok(FATES.includes('compat-wrapper'));
});

test('SEA-INV-07: сравнение не зависит от порядка записей', async (t) => {
  const root = await fixture(t);

  await put(root, 'server/src/e.ts', 'const pid = process.execPath;\n');

  const scanned = await scanProject(root);
  const same = [...scanned].reverse();

  assert.deepEqual(compareInventory(same, scanned), []);
});
