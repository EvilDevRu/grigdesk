import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';

import { createSourceSnapshot, sourceFingerprint } from '../../tools/distributionSnapshot.mts';

const execute = promisify(execFile);

/**
 * Фикстура создаёт отдельный git-источник и локальное правило исключения секрета.
 * Коммиты тестовой базы не затрагивают ветку и индекс рабочего проекта.
 */
async function gitRepository(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-snapshot-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'VERSION'), '0.3.0\n');
  await execute('git', ['init', '-q', root]);

  // Игнорирование секрета локально этому репозиторию: глобальный exclude хоста
  // не должен влиять на исход теста.
  await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '.env\n');
  await execute('git', ['add', 'VERSION'], { cwd: root });
  await execute('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid',
    'commit', '-qm', 'база'], { cwd: root });

  return root;
}

test('SNAPSHOT-STATE: dirty/staged/untracked копируются точно, игнорируемое нет', async (t) => {
  const root = await gitRepository(t);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-run-'));

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'tracked.txt'), 'неожиданное изменение\n');
  await execute('git', ['add', 'tracked.txt'], { cwd: root });
  await fs.writeFile(path.join(root, 'untracked.txt'), 'новый файл\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');

  const snapshot = await createSourceSnapshot({ root, runDir });

  assert.equal(await fs.readFile(path.join(snapshot.cloneRoot, 'tracked.txt'), 'utf8'),
    'неожиданное изменение\n');
  assert.equal(await fs.readFile(path.join(snapshot.cloneRoot, 'untracked.txt'), 'utf8'),
    'новый файл\n');
  await assert.rejects(fs.stat(path.join(snapshot.cloneRoot, '.env')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'),
    'неожиданное изменение\n');
});

test('SNAPSHOT-RACE: изменение источника во время копирования даёт source_changed_retry', async (t) => {
  const root = await gitRepository(t);
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-run-'));

  t.after(() => fs.rm(runDir, { recursive: true, force: true }));

  const tree = path.join(root, 'big-untracked');

  await fs.mkdir(tree, { recursive: true });

  for (let index = 0; index < 4000; index += 1) {
    await fs.writeFile(path.join(tree, `file-${index}.txt`), `содержимое ${index}\n`);
  }

  const attempt = createSourceSnapshot({ root, runDir });

  await new Promise((resolve) => setTimeout(resolve, 30));
  await fs.writeFile(path.join(root, 'tracked.txt'), 'гонка\n');

  await assert.rejects(attempt, /source_changed_retry/u);
  assert.equal(await sourceFingerprint(root), await sourceFingerprint(root));
});
