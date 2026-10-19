import assert from 'node:assert/strict';
import test from 'node:test';

import { GLM_ADMISSION } from '../../deepseek/src/runtime/glmCompatibility.ts';

test('GLM_ADMISSION допускает только api с identity, прошедшей живую проверку', () => {
  assert.deepEqual(GLM_ADMISSION, [{
    mode: 'api',
    compatibility: 'f38161e4c8bd327edc0b27bd1919ff61fec7c96e0e5a31ced0dcf2ac022d66e5',
  }]);
  assert.equal(Object.isFrozen(GLM_ADMISSION), true);
  assert.equal(GLM_ADMISSION.every((entry) => Object.isFrozen(entry)), true);
});

test('режимы допуска выпуска остаются закрытыми до решения владельца', () => {
  // Поставка допускает только api; coding-plan без подтверждения права подписки закрыт.
  assert.deepEqual(GLM_ADMISSION.map((entry) => entry.mode), ['api']);
});
