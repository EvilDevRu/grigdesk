import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBoardDashboard, isBoardDashboard } from '../../web/src/shared/boardContracts.ts';

test('B-STOCK-LEGACY-DTO-01: старый decoder принимает stock без salary-полей', () => {
  const snapshot = {
    userId: 7,
    trackerId: 'b24-stock',
    capabilities: {
      create: true,
      complete: true,
      users: true,
      projects: true,
      timer: false,
      widgets: false,
      comments: false,
      attachments: false,
      editing: false,
      renew: false,
    },
    tasks: [{ id: 42, title: 'Облачная задача' }],
    toReview: [],
    created: [],
    accomplice: [],
    auditor: [],
    widgets: [],
  };

  assert.equal(isBoardDashboard(snapshot), true);

  const decoded = decodeBoardDashboard(snapshot);

  assert.equal(decoded.tasks[0].id, 42);
  assert.equal(decoded.today, undefined);
  assert.equal(decoded.month, undefined);
  assert.equal(decoded.charts, undefined);
  assert.deepEqual(decoded.widgets, []);
});
