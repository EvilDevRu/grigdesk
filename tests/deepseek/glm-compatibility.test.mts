import assert from 'node:assert/strict';
import test from 'node:test';

import { GLM_ADMISSION } from '../../deepseek/src/runtime/glmCompatibility.ts';

test('GLM_ADMISSION допускает api и coding-plan с проверенными живыми identity', () => {
  assert.deepEqual(GLM_ADMISSION.toSorted((left, right) => left.mode.localeCompare(right.mode)), [{
    mode: 'api',
    compatibility: '6b17c77865a8a540bc396f4289bdeed8684d5a7f25425b0011aefa5a841eb9a7',
  }, {
    mode: 'coding-plan',
    compatibility: 'f9c39e6f240dcd12136ce32722da177f8b513f3d92d8bd0be91a6efee09ded28',
  }]);
  assert.equal(Object.isFrozen(GLM_ADMISSION), true);
  assert.equal(GLM_ADMISSION.every((entry) => Object.isFrozen(entry)), true);
});

test('каждому режиму соответствует собственный отпечаток допуска', () => {
  assert.deepEqual(GLM_ADMISSION.map((entry) => entry.mode).toSorted(), ['api', 'coding-plan']);
  assert.equal(new Set(GLM_ADMISSION.map((entry) => entry.compatibility)).size, 2);
});
