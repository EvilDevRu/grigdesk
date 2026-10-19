import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { brokenEntrypointReferences, ENTRYPOINTS } from '../../tools/entrypointGraph.mts';
import { uncheckedTypeScript } from '../../tools/migrationInventory.mts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Читает текстовый файл репозитория относительно корня.
 * Отсутствующий файл — ошибка теста, а не пустая строка.
 */
function source(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

test('BG-01: b24 имеет собственный пакет без runtime npm-зависимостей', () => {
  const manifest = JSON.parse(source('b24/package.json'));
  const lock = JSON.parse(source('b24/package-lock.json'));

  assert.equal(manifest.name, 'grigdesk-b24');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.devDependencies, {
    '@types/node': '22.20.1',
    esbuild: '0.25.12',
    postject: '1.0.0-alpha.6',
    typescript: '5.9.3',
  });
  assert.equal(lock.packages[''].name, 'grigdesk-b24');
  assert.equal(manifest.scripts.test, 'node scripts/test.mts');
  assert.equal(manifest.scripts['test:sea'], 'node scripts/test.mts --sea');
  assert.equal(manifest.scripts.pretest, 'npm run typecheck');
  assert.match(source('b24/scripts/test.mts'), /run-node-tests-safe\.sh/);
  assert.match(source('b24/scripts/test.mts'), /'tests\/b24\/sea' : 'tests\/b24'/);
});

test('BG-02: общий прогон включает быстрый b24 и исключает сборку SEA', () => {
  const runAll = source('tests/run-all.sh');

  assert.match(runAll, /npm --prefix "\$PROJECT_ROOT\/b24" test \|\| RC=1/);

  // SEA DeepSeek входит в свой обязательный gate; прежний запрет относится к b24.
  // Проверяем именно команды этого пакета, сохраняя запрет его сборки в общем прогоне.
  const b24Commands = runAll.split('\n').filter((line) => line.includes('b24')).join('\n');

  assert.doesNotMatch(b24Commands, /test:sea|b24" run build|b24\/scripts\/build/);
});

test('BG-03: b24 включён в покрытие TypeScript', () => {
  assert.deepEqual(uncheckedTypeScript().filter((file) => file.startsWith('b24/')
    || file.startsWith('tests/b24/')), []);
});

test('BG-04: граф запуска знает b24/main и build', () => {
  assert.ok(ENTRYPOINTS.includes('b24/src/main.ts'));
  assert.ok(ENTRYPOINTS.includes('b24/scripts/build.mts'));
  assert.deepEqual(brokenEntrypointReferences().filter((item) => item.from.startsWith('b24/')), []);

  const fixture = mkdtempSync(path.join(os.tmpdir(), 'b24-graph-'));

  mkdirSync(path.join(fixture, 'b24/src'), { recursive: true });
  writeFileSync(path.join(fixture, 'b24/src/main.ts'), "import { missing } from './missing.ts';\n");

  assert.ok(brokenEntrypointReferences(fixture).some((item) => item.from === 'b24/src/main.ts'
    && item.spec === './missing.ts'));
});

test('BG-05: раскладка разрешает b24 output и требует исходники', () => {
  const layout = source('tests/layout.sh');

  assert.match(layout, /\n\s+tests\/b24 \\\n/);
  assert.match(layout, /\n\s+b24\/test \\\n\s+b24\/tests/);
  assert.ok(existsSync(path.join(ROOT, 'b24/src/main.ts')));
  assert.ok(existsSync(path.join(ROOT, 'b24/package.json')));

  for (const ignored of ['bin/b24', 'bin/.b24-1.tmp', 'b24/.cache/archive', 'b24/node_modules/x']) {
    execFileSync('git', ['check-ignore', '-q', '--no-index', ignored], { cwd: ROOT });
  }

  const binary = path.join(ROOT, 'bin/b24');

  if (existsSync(binary)) {
    const head = readFileSync(binary).subarray(0, 2).toString();

    assert.notEqual(head, '#!', 'bin/b24 должен быть собранным ELF');
  }
});
