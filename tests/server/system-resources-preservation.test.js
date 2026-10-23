import assert from 'node:assert/strict';
import test from 'node:test';

import { SystemAdapter } from '../../server/src/adapters/system.ts';
import { legacyPorts } from './helpers/system-resources-fixture.js';

test('PRES-01: прежние CPU/mem/net и fallback без proc', (t) => {
  const ports = legacyPorts(t);
  const adapter = new SystemAdapter();

  t.after(() => adapter.stop());
  ports.idle += 25;
  ports.user += 75;
  adapter._tick();

  const snapshot = adapter.read();

  assert.deepEqual(snapshot.cpu, {
    percent: 75,
    cores: 4,
    load1: 1.23,
  });
  assert.deepEqual(snapshot.mem, {
    totalGb: 24,
    usedGb: 16,
    freeGb: 8,
    percent: 67,
    ramTotalGb: 16,
    ramUsedGb: 12,
    ramFreeGb: 4,
    ramPercent: 75,
    swapTotalGb: 8,
    swapUsedGb: 4,
    swapPercent: 50,
  });
  assert.deepEqual(snapshot.net, {
    ip: '192.0.2.1',
    country: 'Фикстура',
    countryCode: 'ZZ',
  });

  ports.procMissing = true;
  adapter._tick();

  const fallback = adapter.read();

  assert.equal(fallback.mem.totalGb, 16);
  assert.equal(fallback.mem.usedGb, 12);
  assert.equal(fallback.mem.freeGb, 4);
  assert.equal(fallback.mem.percent, 75);
  assert.equal(fallback.mem.swapTotalGb, 0);
  assert.equal(fallback.mem.swapUsedGb, 0);
  assert.equal(fallback.mem.swapPercent, 0);
  assert.equal(fallback.cpu.percent, 0);
  assert.equal(fallback.cpu.cores, 4);
  assert.equal(fallback.cpu.load1, 1.23);
  assert.deepEqual(fallback.net, snapshot.net);
});
