import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const writer = new URL('../../server/scripts/glmSmokeAdmission.mts', import.meta.url);

test('Параллельные процессы сохраняют оба допуска GLM и снимают блокировку', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glm-smoke-admission-'));
  const file = path.join(root, 'glm.json');

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(file, JSON.stringify({
    profileRevision: 'fixture',
    admission: [{ mode: 'api', compatibility: 'previous' }],
  }));
  await chmod(file, 0o640);

  const code = [
    `import { writeGlmSmokeAdmission } from ${JSON.stringify(writer.href)};`,
    'process.umask(0o077);',
    'await writeGlmSmokeAdmission(...process.argv.slice(1));',
  ].join('\n');

  await Promise.all(['api', 'coding-plan'].map((mode) => execute(process.execPath, [
    '--input-type=module', '-e', code, file, mode, `verified-${mode}`,
  ])));

  const result = JSON.parse(await readFile(file, 'utf8'));

  assert.equal(result.profileRevision, 'fixture');
  assert.deepEqual(result.admission.sort((left, right) => left.mode.localeCompare(right.mode)), [
    { mode: 'api', compatibility: 'verified-api' },
    { mode: 'coding-plan', compatibility: 'verified-coding-plan' },
  ]);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(root), ['glm.json']);
});
