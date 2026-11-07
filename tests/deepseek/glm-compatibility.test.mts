import assert from 'node:assert/strict';
import test from 'node:test';

import { GLM_ADMISSION } from '../../deepseek/src/runtime/glmCompatibility.ts';

test('GLM_ADMISSION допускает api и coding-plan с проверенными живыми identity', () => {
  assert.deepEqual(GLM_ADMISSION, [{
    mode: 'api',
    compatibility: '74f481c1429bc1d34008e5114a5f6c11d22dc1ac5bcd4cac470569fedb6e00aa',
  }, {
    mode: 'coding-plan',
    compatibility: 'cec077352a4f30466bcbc531ed4010539e8b675d3b9ce852a5b01f8290081522',
  }]);
  assert.equal(Object.isFrozen(GLM_ADMISSION), true);
  assert.equal(GLM_ADMISSION.every((entry) => Object.isFrozen(entry)), true);
});

test('каждому режиму соответствует собственный отпечаток допуска', () => {
  assert.deepEqual(GLM_ADMISSION.map((entry) => entry.mode), ['api', 'coding-plan']);
  assert.equal(new Set(GLM_ADMISSION.map((entry) => entry.compatibility)).size, 2);
});
