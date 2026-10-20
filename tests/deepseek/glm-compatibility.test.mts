import assert from 'node:assert/strict';
import test from 'node:test';

import { GLM_ADMISSION } from '../../deepseek/src/runtime/glmCompatibility.ts';

test('GLM_ADMISSION допускает только api с identity, прошедшей живую проверку', () => {
  assert.deepEqual(GLM_ADMISSION, [{
    mode: 'api',
    compatibility: 'ea7a8933ab635014610ba0be5d6ea70f2459293e05dba4799ea6faccda93347e',
  }]);
  assert.equal(Object.isFrozen(GLM_ADMISSION), true);
  assert.equal(GLM_ADMISSION.every((entry) => Object.isFrozen(entry)), true);
});

test('режимы допуска выпуска остаются закрытыми до решения владельца', () => {
  // Поставка допускает только api; coding-plan без подтверждения права подписки закрыт.
  assert.deepEqual(GLM_ADMISSION.map((entry) => entry.mode), ['api']);
});
