import assert from 'node:assert/strict';
import test from 'node:test';

import { createPermissionQueue } from '../../server/src/lib/chat/permissionQueue.ts';

function dbRequest() {
  return {
    origin: 'db',
    chatKey: 'chat-a',
    canRemember: true,
    presentation: {
      profile: { label: 'Прод-заказы', role: 'read' },
      engine: { id: 'mysql', label: 'MySQL' },
      prod: true,
      query: 'SELECT id FROM orders',
      queryClass: 'read',
      tables: ['orders'],
      rowEstimate: null,
      autoReadReason: { code: 'prod_auto_read_disabled', message: 'На проде нужен отдельный допуск' },
    },
  };
}

test('DB-подтверждение нельзя снять generic endpoint или remember-флагом', async () => {
  const queue = createPermissionQueue({ timeoutMs: 24 * 60 * 60 * 1000 });
  const pending = queue.enqueue(dbRequest());
  const answer = await queue.answer(pending.pid, 'chat', { allow: true, remember: true });
  queue.cancel(pending.pid);

  assert.deepEqual({
    answer,
    canRemember: pending.canRemember,
    presentation: pending.presentation,
  }, {
    answer: { ok: false, error: 'origin_mismatch' },
    canRemember: false,
    presentation: dbRequest().presentation,
  });
});
