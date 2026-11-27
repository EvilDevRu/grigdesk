import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { GLM_ADMISSION } from '../../deepseek/src/runtime/glmCompatibility.ts';

test('GLM_ADMISSION загружает сохранённые записи без подмены отпечатков', async () => {
  const file = new URL('../../deepseek/compatibility/glm.json', import.meta.url);
  const { admission } = JSON.parse(await readFile(file, 'utf8'));

  assert.deepEqual(GLM_ADMISSION, admission);
  assert.equal(Object.isFrozen(GLM_ADMISSION), true);
  assert.equal(GLM_ADMISSION.every((entry) => Object.isFrozen(entry)), true);
});

test('каждому режиму соответствует собственный отпечаток допуска', () => {
  assert.deepEqual(GLM_ADMISSION.map((entry) => entry.mode).toSorted(), ['api', 'coding-plan']);
  assert.equal(new Set(GLM_ADMISSION.map((entry) => entry.compatibility)).size, 2);
  assert.ok(GLM_ADMISSION.every((entry) => /^[a-f0-9]{64}$/u.test(entry.compatibility)));
});
