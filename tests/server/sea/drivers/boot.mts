import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { environment, freePort, ready, tracked, within } from './common.mts';

const root = process.argv[2];

assert.ok(root);

const port = await freePort();
let mobilePort = await freePort();

while (mobilePort === port) {
  mobilePort = await freePort();
}

await writeFile('/D/.env', `GRIGDESK_PORT=${port}\nGRIGDESK_MOBILE_PORT=${mobilePort}\n`);

const env = environment();
const run = tracked(path.join(root, 'bin/grigdesk-ctl'), ['run'], env);
let second: ReturnType<typeof tracked> | undefined;

try {
  await ready(run, port);

  const binary = await realpath(path.join(root, 'server/grigdesk-server'));
  const executable = await realpath(`/proc/${run.child.pid}/exe`);
  const auth = await (await fetch(`http://127.0.0.1:${port}/api/auth/state`)).json() as {
    configured: boolean;
    authenticated: boolean;
  };
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);

  assert.equal(executable, binary);
  assert.equal(typeof auth.configured, 'boolean');
  assert.equal(auth.authenticated, false);
  assert.equal(health.status, 401);
  assert.equal((await health.json() as { error: string }).error, 'unauthorized');
  second = tracked(binary, [], { ...env, GRIGDESK_PORT: String(await freePort()) });

  // Штатный lock ждёт 15 секунд: срок наблюдения включает boot и запас планировщика.
  const locked = await within(second.exited, 25000);

  assert.equal(locked.code, 78, second.log());
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/state`)).status, 200);

  const stopped = await run.stop();

  assert.equal(stopped.code, 0, run.log());
  assert.equal(existsSync('/D/state/server.lock'), false);
  assert.equal((await readFile(binary)).subarray(1, 4).toString(), 'ELF');
  console.log(JSON.stringify({
    ready: true,
    lockCode: locked.code,
    shutdownCode: stopped.code,
    lockReleased: true,
    isSea: true,
  }));
} finally {
  await second?.stop();
  await run.stop();
}
