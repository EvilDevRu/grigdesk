import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatTaskReference, isTaskSourceId, parseTaskReference, taskReferenceKey,
} from '../../shared/tasks/taskReference.ts';

const external = `grigdesk-b24@${'a'.repeat(64)}` as const;

test('ссылки сохраняют источник и прежний числовой формат', () => {
  for (const value of ['42', 'grigdesk:100000000000', `${external}:42`]) {
    const reference = parseTaskReference(value);

    assert.ok(reference);
    assert.equal(formatTaskReference(reference), value);
    assert.equal(parseTaskReference(new URL(`http://example.test/?openTask=${encodeURIComponent(value)}`)
      .searchParams.get('openTask'))?.id, reference.id);
  }
});

test('неизвестный источник и недопустимый own-номер не теряют префикс', () => {
  for (const value of ['grigdesk:42', 'b24:42', 'unknown:42', 'grigdesk:100000000000:42', '0']) {
    assert.equal(parseTaskReference(value), null);
  }

  assert.notEqual(taskReferenceKey({ id: '42', source: external }),
    taskReferenceKey({ id: '42', source: `grigdesk-b24@${'b'.repeat(64)}` }));
});

test('OWN-REMOVED-REF: legacy отличается от bare и не становится активным source', () => {
  const legacy = parseTaskReference('grigdesk:100000000000');
  const bare = parseTaskReference('100000000000');

  assert.deepEqual(legacy, { id: '100000000000', unavailable: 'legacy-own' });
  assert.deepEqual(bare, { id: '100000000000' });
  assert.notEqual(taskReferenceKey(legacy!), taskReferenceKey(bare!));
  assert.equal(formatTaskReference(legacy!), 'grigdesk:100000000000');
  assert.equal(isTaskSourceId('grigdesk'), false);
  assert.equal(isTaskSourceId(external), true);
});
