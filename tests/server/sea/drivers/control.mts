import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import path from 'node:path';

import { tracked, within } from './common.mts';
import { preferences, server } from './harness.mts';

const root = process.argv[2]!;

await preferences();

const first = await server(root, { GRIGDESK_DESKTOP_CHILD: '1' }, true);
let second: Awaited<ReturnType<typeof server>> | undefined;
const peer = tracked(path.join(root, 'runtime/node/bin/node'), ['-e', 'setInterval(() => {}, 1000)'], {});

try {
  assert.equal((await first.request('/api/system/server')).mode, 'desktop');
  assert.deepEqual(await first.request('/api/system/restart', 'POST'), { ok: true, mode: 'desktop' });
  assert.equal((await within(first.exited, 45000)).code, 75, first.log());
  assert.equal(existsSync('/D/state/server.lock'), false);
  second = await server(root, { GRIGDESK_DESKTOP_CHILD: '1' }, true);
  assert.notEqual(first.child.pid, second.child.pid);
  assert.equal(await readlink(`/proc/${second.child.pid}/exe`), path.join(root, 'server/grigdesk-server'));
  second.child.disconnect();
  assert.equal((await within(second.exited, 45000)).code, 0, second.log());
  assert.equal(existsSync('/D/state/server.lock'), false);
  assert.equal(peer.finished(), false);
  console.log(JSON.stringify({
    restartCode: 75,
    sameExecutable: true,
    disconnectCode: 0,
    lockRemoved: true,
  }));
} finally {
  await first.stop();
  await second?.stop();
  await peer.stop();
}
