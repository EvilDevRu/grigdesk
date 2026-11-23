import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import {
  applyNetworkFamilyAttemptTimeout,
  NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS,
} from '../../server/src/lib/networkFamily.ts';
import { runIsolatedNetworkWorker } from '../../server/src/lib/isolatedNetworkWorker.ts';

test('предел попыток happy-eyeballs применяется в текущем процессе', () => {
  const previous = net.getDefaultAutoSelectFamilyAttemptTimeout();

  applyNetworkFamilyAttemptTimeout();

  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
  net.setDefaultAutoSelectFamilyAttemptTimeout(previous);
});

// Ребёнок не наследует дефолты родителя: предел должен стоять в его собственном bootstrap.
test('сетевой ребёнок применяет предел попыток выбора семейства', async () => {
  const value = await runIsolatedNetworkWorker({
    operation: "async () => (await import('node:net')).getDefaultAutoSelectFamilyAttemptTimeout()",
    request: {},
    timeoutMs: 8_000,
    maxOutputBytes: 1_024,
  });

  assert.equal(value, NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
});