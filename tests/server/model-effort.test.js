import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRequestedEffort } from '../../server/src/lib/model-effort.js';

test('explicit effort is accepted only when the live catalog reports it', () => {
  assert.deepEqual(
    resolveRequestedEffort('ultra', ['low', 'ultra']),
    { ok: true, effort: 'ultra' },
  );
  assert.deepEqual(
    resolveRequestedEffort('max', ['low', 'ultra']),
    { ok: false, effort: undefined, levels: ['low', 'ultra'] },
  );
});

test('missing catalog levels do not create a fallback list', () => {
  assert.deepEqual(
    resolveRequestedEffort('max', []),
    { ok: false, effort: undefined, levels: [] },
  );
  assert.deepEqual(resolveRequestedEffort('', []), { ok: true, effort: undefined });
});
