import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { streamProbe } from './helpers/streamProbe.js';

for (const code of [0, 23]) {
  test(`BOUT-STREAM: stdout/stderr до закрытия, stage-log и exit ${code}`, async (t) => {
    const result = await streamProbe(t,
      new URL('../../server/scripts/buildBinary.mts', import.meta.url), 'loggedStage', code);
    const log = await fs.readFile(`${result.prefix}probe.log`, 'utf8');

    for (const line of ['first-out', 'first-err', 'last-out', 'last-err']) {
      assert.ok(log.includes(line), line);
    }

    assert.ok(log.includes('x'.repeat(131072)));
    assert.ok(log.includes('y'.repeat(131072)));
    assert.equal(await fs.readFile(`${result.prefix}probe.exit`, 'utf8'), `${code}\n`);

    if (code) {
      assert.match(result.stderr, /probe.*23/u);
    }
  });
}
