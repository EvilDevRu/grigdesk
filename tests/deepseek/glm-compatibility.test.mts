import assert from 'node:assert/strict';
import test from 'node:test';

import { GLM_ADMISSION } from '../../deepseek/src/runtime/glmCompatibility.ts';

test('GLM_ADMISSION допускает api и coding-plan с проверенными живыми identity', () => {
  assert.deepEqual(GLM_ADMISSION.toSorted((left, right) => left.mode.localeCompare(right.mode)), [{
    mode: 'api',
    compatibility: 'e283e8ee57dcd06e1caaf2abb0ec186f7fc691ebee04cda0f0cf9873966fab47',
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
