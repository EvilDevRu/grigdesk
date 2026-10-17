import assert from 'node:assert/strict';
import test from 'node:test';

import { unreflectedReservationAmount } from '../../server/src/lib/studio3d/jobReservations.ts';

const accepted = (amount, balanceBefore) => ({
  amount,
  accepted: true,
  balanceBefore,
});
const pending = (amount) => ({
  amount,
  accepted: false,
  balanceBefore: null,
});
const cases = [
  [[], 100, 0],
  [[pending(7)], 100, 7],
  [[accepted(30, null)], 100, 30],
  [[accepted(30, 100)], 100, 30],
  [[accepted(30, 100)], 90, 20],
  [[accepted(30, 100)], 60, 0],
  [[accepted(30, 100), accepted(20, 100)], 75, 25],
  [[accepted(30, 100), accepted(20, 100), pending(7)], 75, 32],
  [[accepted(30, 100), accepted(20, 80)], 90, 40],
  [[accepted(30, 100), accepted(20, null), pending(7)], 90, 47],
  [[accepted(30, 100), accepted(20, 80)], 120, 50],
  [[accepted(30, 100)], null, 30],
  [[accepted(30, 100), pending(7)], 60, 7],
  [[accepted(30, 100), accepted(20, null)], 60, 20],
  [[accepted(20, 80), accepted(30, 100)], 90, 40],
];

for (const [index, [holds, available, expected]] of cases.entries()) {
  test(`Резервы: строка ${index + 1}, доступно ${available}, удержано ${expected}`, () => {
    const before = structuredClone(holds);

    for (const hold of holds) {
      Object.freeze(hold);
    }

    Object.freeze(holds);
    assert.equal(unreflectedReservationAmount(holds, available), expected);
    assert.deepEqual(holds, before);
  });
}
