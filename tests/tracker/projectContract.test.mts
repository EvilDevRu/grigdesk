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

test('BG-01: tracker имеет собственный пакет без runtime npm-зависимостей', () => {
  const manifest = JSON.parse(source('tracker/package.json'));
  const lock = JSON.parse(source('tracker/package-lock.json'));

  assert.equal(manifest.name, 'grigdesk-tracker');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.devDependencies, {
    '@types/node': '22.20.1',
    esbuild: '0.25.12',
    postject: '1.0.0-alpha.6',
    typescript: '5.9.3',
  });
  assert.equal(lock.packages[''].name, 'grigdesk-tracker');
  assert.equal(manifest.scripts.test, 'node scripts/test.mts');
  assert.equal(manifest.scripts['test:sea'], 'node scripts/test.mts --sea');
  assert.equal(manifest.scripts.pretest, 'npm run typecheck');
  assert.match(source('tracker/scripts/test.mts'), /run-node-tests-safe\.sh/);
  assert.match(source('tracker/scripts/test.mts'), /'tests\/tracker\/sea' : 'tests\/tracker'/);
});

test('BG-02: общий прогон включает быстрый tracker и исключает сборку SEA', () => {
  const runAll = source('tests/run-all.sh');

  assert.match(runAll, /npm --prefix "\$PROJECT_ROOT\/tracker" test \|\| RC=1/);

  // SEA DeepSeek входит в свой обязательный gate; прежний запрет относится к tracker.
  // Проверяем именно команды этого пакета, сохраняя запрет его сборки в общем прогоне.
  const b24Commands = runAll.split('\n').filter((line) => line.includes('tracker')).join('\n');

  assert.doesNotMatch(b24Commands, /test:sea|tracker" run build|tracker\/scripts\/build/);
});

test('BG-03: tracker включён в покрытие TypeScript', () => {
  assert.deepEqual(uncheckedTypeScript().filter((file) => file.startsWith('tracker/')
    || file.startsWith('tests/tracker/')), []);
});

test('BG-04: граф запуска знает tracker/main и build', () => {
  assert.ok(ENTRYPOINTS.includes('tracker/src/main.ts'));
  assert.ok(ENTRYPOINTS.includes('tracker/scripts/build.mts'));
  assert.deepEqual(brokenEntrypointReferences().filter((item) => item.from.startsWith('tracker/')), []);

  const fixture = mkdtempSync(path.join(os.tmpdir(), 'tracker-graph-'));

  mkdirSync(path.join(fixture, 'tracker/src'), { recursive: true });
  writeFileSync(path.join(fixture, 'tracker/src/main.ts'), "import { missing } from './missing.ts';\n");

  assert.ok(brokenEntrypointReferences(fixture).some((item) => item.from === 'tracker/src/main.ts'
    && item.spec === './missing.ts'));
});

test('BG-05: раскладка разрешает tracker output и требует исходники', () => {
  const layout = source('tests/layout.sh');

  assert.match(layout, /\n\s+tests\/tracker \\\n/);
  assert.match(layout, /\n\s+tracker\/test \\\n\s+tracker\/tests/);
  assert.ok(existsSync(path.join(ROOT, 'tracker/src/main.ts')));
  assert.ok(existsSync(path.join(ROOT, 'tracker/package.json')));

  for (const ignored of ['bin/tracker', 'bin/.tracker-1.tmp', 'tracker/.cache/archive', 'tracker/node_modules/x']) {
    execFileSync('git', ['check-ignore', '-q', '--no-index', ignored], { cwd: ROOT });
  }

  const binary = path.join(ROOT, 'bin/tracker');

  if (existsSync(binary)) {
    const head = readFileSync(binary).subarray(0, 2).toString();

    assert.notEqual(head, '#!', 'bin/tracker должен быть собранным ELF');
  }
});
