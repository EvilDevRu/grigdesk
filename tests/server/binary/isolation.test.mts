import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { isolatedBinary } from './isolation.mts';

test('SB25-ISOLATION: ordinary Node работает только из подготовленного R', async (t) => {
  const fixture = await isolatedBinary(t, {
    candidate: process.env.GRIGDESK_TEST_SERVER_BINARY!,
    deepseekBinary: process.env.GRIGDESK_TEST_DEEPSEEK_BINARY!,
  });

  assert.ok(fixture, 'Namespace fixture должен предоставить собственные D/I/R');

  const report = await fixture.run(path.join(import.meta.dirname, 'drivers/isolation.mts'));

  assert.equal(report.sourceAbsent, true);
  assert.equal(report.hostHomeAbsent, true);
  assert.equal(report.hostNodeCode, 97);
  assert.equal(report.installationReadOnly, true);
  assert.equal(report.deepseekReadOnly, true);
  assert.equal(report.dataWritable, true);
  assert.equal(report.node, `${fixture.paths.runtime}/runtime/node/bin/node`);
  assert.equal(report.nodeVersion, 'v24.21.0');
  assert.equal(report.awk, '14');
});
