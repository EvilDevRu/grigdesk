import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { reserveSlot } from '../../server/src/lib/sandboxSlots.ts';

async function fixture(t, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-slots-single-'));
  const stateDir = path.join(root, 'state');
  const factoryBin = path.join(root, 'factory');
  await mkdir(stateDir, { recursive: true });
  await writeFile(factoryBin, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { stateDir, factoryBin };
}

test('slot allocator accepts only explicit supported:false as no-slot contract', async (t) => {
  const fx = await fixture(t, `printf '%s\\n' '{"supported":false,"reason":"shared profile"}'`);
  const slot = await reserveSlot({
    ...fx, profilesDir: '/profiles', profile: 'shared', task: '42',
  });
  assert.deepEqual(slot, { k: null, source: 'none', reason: 'shared profile' });
});

test('slot query failure is fail-closed instead of silently launching without reservation', async (t) => {
  const fx = await fixture(t, `printf '%s\\n' 'broken slots' >&2\nexit 1`);
  await assert.rejects(
    reserveSlot({ ...fx, profilesDir: '/profiles', profile: 'broken', task: '42' }),
    /broken slots|factory slots/,
  );
});
