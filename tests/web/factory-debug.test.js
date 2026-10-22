import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FACTORY_DEBUG_LEVELS,
  factoryDebugPayload,
} from '../../web/src/shared/factoryDebug.ts';

test('settings exposes every engine debug level including off', () => {
  assert.deepEqual(
    FACTORY_DEBUG_LEVELS.map((item) => item.value),
    ['off', 'errors', 'decisions', 'verbose'],
  );
  assert.equal(FACTORY_DEBUG_LEVELS[0].label, 'Выключено');
});

test('global settings payload cannot carry unknown values', () => {
  assert.deepEqual(factoryDebugPayload('decisions'), {
    scope: 'global',
    level: 'decisions',
  });
  assert.throws(() => factoryDebugPayload('trace-everything'), /уровень/);
});
