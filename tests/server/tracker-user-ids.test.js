import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTaskUpdateFields } from '../../server/src/lib/trackers/taskFields.ts';

const ACCOUNT = '712020:account-id';

test('Пользовательские поля принимают accountId и сохраняют числовые id', () => {
  assert.deepEqual(normalizeTaskUpdateFields({
    responsibleId: ` ${ACCOUNT} `,
    accomplices: [7, '9', ACCOUNT],
    auditors: [ACCOUNT, 10],
    groupId: '12',
  }), {
    responsibleId: ACCOUNT,
    accomplices: [7, 9, ACCOUNT],
    auditors: [ACCOUNT, 10],
    groupId: 12,
  });
  assert.deepEqual(normalizeTaskUpdateFields({ responsibleId: '7' }), { responsibleId: 7 });
  assert.deepEqual(normalizeTaskUpdateFields({ responsibleId: 'x'.repeat(100) }), {
    responsibleId: 'x'.repeat(100),
  });
});

test('Пользовательские id отвергают пустые строки, длинные строки и некорректные числа', () => {
  for (const id of ['', ' ', 'x'.repeat(101), '1'.repeat(101), '0'.repeat(100) + '7',
    0, -1, 1.5, true, null, {}, []]) {
    for (const key of ['responsibleId', 'accomplices', 'auditors']) {
      const input = { [key]: key === 'responsibleId' ? id : [id] };

      assert.throws(() => normalizeTaskUpdateFields(input), { code: 'b24_bad_request' });
    }
  }
});

test('Очистка участников сохранена; groupId по-прежнему только числовой', () => {
  for (const value of ['', null, []]) {
    assert.deepEqual(normalizeTaskUpdateFields({ accomplices: value, auditors: value }), {
      accomplices: value === null ? '' : value,
      auditors: value === null ? '' : value,
    });
  }

  for (const groupId of [ACCOUNT, 'x', '12x', -1, 1.5, true, {}]) {
    assert.throws(() => normalizeTaskUpdateFields({ groupId }), { code: 'b24_bad_request' });
  }

  assert.deepEqual(normalizeTaskUpdateFields({ groupId: 9 }), { groupId: 9 });
  assert.deepEqual(normalizeTaskUpdateFields({ groupId: null }), { groupId: null });
});
