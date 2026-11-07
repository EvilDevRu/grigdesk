import assert from 'node:assert/strict';
import test from 'node:test';

import schema from '../fixtures/executor-settings/schemastery.json' with { type: 'json' };
import { normalizeSchemastery } from '../../server/src/lib/executorSettings/schemastery.ts';
import { validateNativeSetting } from '../../server/src/lib/executorSettings/validation.ts';

test('uid/refs Schemastery раскрывают поля, enum и шаг относительно minimum', () => {
  const fields = normalizeSchemastery(schema, {
    path: ['namespace'],
    writeChannel: {
      id: 'document',
      scope: 'grigdesk-chats',
      state: 'verified',
    },
    ownership: [],
  });

  assert.equal(fields[0]?.kind, 'boolean');
  assert.deepEqual(fields[0]?.default, { state: 'known', value: false });
  assert.deepEqual(fields[2]?.constraints.enum, ['first', 'second']);
  assert.equal(validateNativeSetting(fields, '["namespace","count"]', 1.5), null);
  assert.equal(validateNativeSetting(fields, '["namespace","count"]', 1)?.code, 'invalid_value');
});
