import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatTaskReference, parseTaskReference, taskReferenceKey,
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
