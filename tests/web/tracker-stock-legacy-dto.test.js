import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBoardDashboard, isBoardDashboard } from '../../web/src/shared/boardContracts.ts';

import { stockDriverModule } from '../server/helpers/trackerPackage.js';

test('B-STOCK-LEGACY-DTO-01: decoder принимает ответ внешнего stock без salary-полей', async (t) => {
  const driverModule = await stockDriverModule(t);

  if (!driverModule) {
    return;
  }

  const { default: createDriver } = driverModule;
  const driver = createDriver({
    credentials: { read: () => ({ baseUrl: 'https://cloud.fixture', accessToken: 'fixture' }) },
    fetch: async (url) => Response.json({
      result: String(url).endsWith('/user.current') ? { ID: '7' } : {
        tasks: [{ id: '42', title: 'Облачная задача' }],
      },
    }),
  });
  const snapshot = {
    ...await driver.getDashboard(),
    trackerId: driver.id,
    capabilities: driver.capabilities,
  };

  assert.equal(isBoardDashboard(snapshot), true);

  const decoded = decodeBoardDashboard(snapshot);

  assert.equal(decoded.tasks[0].id, 42);
  assert.equal(decoded.today, undefined);
  assert.equal(decoded.month, undefined);
  assert.equal(decoded.charts, undefined);
  assert.deepEqual(decoded.widgets, []);
});
