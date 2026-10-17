import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY = `b24${'-'}mcp`;
const SKIP_FILES = new Set(['package-lock.json', path.basename(fileURLToPath(import.meta.url))]);
const execFileAsync = promisify(execFile);

// Только tracked и неигнорируемые новые файлы: .env, chats и runtime-state не являются
// кодовой базой и могут законно содержать исторический пользовательский текст.
async function sourceFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const tracked = stdout.split('\0')
    .filter(Boolean)
    .filter((file) => !SKIP_FILES.has(path.basename(file)))
    .map((file) => path.join(ROOT, file));
  // Локальный .env не коммитится, но может незаметно сохранить runtime-зависимость. После
  // переноса данных на его месте ссылка в папку данных: настоящий файл проверяется только там.
  const local = path.join(ROOT, '.env');

  return lstatSync(local, { throwIfNoEntry: false })?.isFile() ? [...tracked, local] : tracked;
}

test('repository has no dependency or stale documentation for the retired B24 project', async () => {
  const hits = [];
  for (const file of await sourceFiles()) {
    let source;
    try {
      // Проверяем исходники/документацию, а не бинарные модели и медиа профилей.
      if ((await stat(file)).size > 4 * 1024 * 1024) continue;
      source = await readFile(file, 'utf8');
    } catch { continue; }
    if (source.includes(LEGACY)) hits.push(path.relative(ROOT, file));
  }
  assert.deepEqual(hits, []);
});
