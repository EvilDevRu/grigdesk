import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { AuthStore } from '../../../../server/src/lib/authStore.ts';
import { environment, freePort, ready, tracked, within } from './common.mts';

const root = process.argv[2];

assert.ok(root);

const WebSocket = createRequire(path.join(root, 'server/package.json'))('ws') as
  typeof import('../../../../server/node_modules/@types/ws/index.d.ts');
const store = new AuthStore({
  legacyAccountPath: '/D/state/auth.json',
  sessionsPath: '/D/state/sessions.json',
});
const cookie = `grigdesk_sid=${store.createSession().id}`;
const port = await freePort();
let mobilePort = await freePort();

while (mobilePort === port) {
  mobilePort = await freePort();
}

await mkdir('/D/user-bin');
await writeFile('/D/user-bin/node', '#!/bin/sh\necho user-node >> /D/user-node-calls\n'
  + `exec '${root}/runtime/node/bin/node' "$@"\n`, { mode: 0o755 });
await writeFile('/D/probe.sh', [
  'set -euo pipefail',
  'printf "%s\\n" "$PATH" > /D/terminal.path',
  'command -v node > /D/terminal.node',
  'printf "%s\\n" "${PYTHONDONTWRITEBYTECODE:-}" > /D/terminal.python',
  'npm -v > /D/npm-version',
  'npm prefix -g > /D/npm-prefix',
  `'${root}/engine/bin/factory-route' --help > /D/factory-help`,
  'printf "__SEA_WRITABLE_%s__\\n" OK',
].join('\n'));

const env = {
  ...environment(),
  PATH: '/D/user-bin:/host-bin:/usr/bin:/bin',
  NPM_CONFIG_PREFIX: path.join(root, 'runtime/node'),
  GRIGDESK_PORT: String(port),
  GRIGDESK_MOBILE_PORT: String(mobilePort),
};
const origin = `http://127.0.0.1:${port}`;
const binary = path.join(root, 'server/grigdesk-server');
const run = tracked(binary, [], env);

try {
  await ready(run, port);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`, {
    headers: { cookie, Origin: origin },
  });
  let output = '';

  try {
    await within(new Promise<void>((resolve, reject) => {
      socket.once('open', () => socket.send(JSON.stringify({ t: 'in', d: 'bash /D/probe.sh\r' })));
      socket.on('message', (data) => {
        output += data.toString();

        if (output.includes('__SEA_WRITABLE_OK__')) {
          resolve();
        }
      });
      socket.once('error', reject);
      socket.once('close', () => reject(new Error(`PTY закрылся: ${output}`)));
    }), 15000).catch((error: Error) => {
      throw new Error(`${error.message}\nPTY: ${output}`);
    });
  } finally {
    socket.close();

    if (socket.readyState !== WebSocket.CLOSED) {
      await within(once(socket, 'close'), 5000).catch(() => socket.terminate());
    }
  }

  const entries = (await readFile('/D/terminal.path', 'utf8')).trim().split(':');

  assert.equal((await readFile('/D/terminal.node', 'utf8')).trim(), '/D/user-bin/node');
  assert.equal(entries.at(-1), path.join(root, 'runtime/node/bin'));
  assert.equal((await readFile('/D/terminal.python', 'utf8')).trim(), '1');
  assert.equal((await readFile('/D/npm-prefix', 'utf8')).trim(), '/D/state/npm-global');
  assert.match(await readFile('/D/npm-version', 'utf8'), /^\d+\.\d+\.\d+/);
  assert.match(await readFile('/D/factory-help', 'utf8'), /usage:/);
  assert.ok((await readFile('/D/user-node-calls', 'utf8')).includes('user-node'));
  assert.equal(existsSync(path.join(root, 'engine/lib/__pycache__')), false);
} finally {
  assert.equal((await run.stop()).code, 0, run.log());
}

const restarted = tracked(binary, [], env);

try {
  await ready(restarted, port);
} finally {
  assert.equal((await restarted.stop()).code, 0, restarted.log());
}

const integrity = tracked(binary, ['--check-runtime'], env);

assert.equal((await within(integrity.exited, 30000)).code, 0, integrity.log());
assert.equal(JSON.parse(integrity.log()).ok, true);
console.log(JSON.stringify({
  userNodeFirst: true,
  bundledNodeLast: true,
  pythonNoCache: true,
  npmOutsideRelease: true,
  restart: true,
  integrity: true,
}));
