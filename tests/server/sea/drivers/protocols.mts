import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { sealUiRelease } from '../../../../desktop/src/uiRelease.ts';
import { startPipe } from '../../../../desktop/src/pipe/pipeServer.ts';
import { createUpstream } from '../../../../desktop/src/pipe/upstream.ts';
import { API_VERSION } from '../../../../shared/client/apiVersion.ts';
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

await mkdir('/D/ui-source', { recursive: true });
await writeFile('/D/ui-source/index.html', '<!doctype html><h1>sea-protocol-ui</h1>');
await sealUiRelease('/D/ui-source');

const origin = `http://127.0.0.1:${port}`;
const env = {
  ...environment(),
  GRIGDESK_PORT: String(port),
  GRIGDESK_MOBILE_PORT: String(mobilePort),
};
const run = tracked(path.join(root, 'server/grigdesk-server'), [], env);
const headers = { cookie, Origin: origin };
let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;

try {
  await ready(run, port);

  const anonymousCodes: Record<string, number | undefined> = {};

  for (const route of ['/api/health', '/api/events', '/api/devices']) {
    const response = await fetch(origin + route);
    const status = response.status;

    anonymousCodes[route] = status;
    assert.equal(status, 401, route);
    assert.equal(response.headers.get('x-grigdesk-api'), '0.1');
  }

  const legacyUi = `/ui/${'a'.repeat(64)}/`;

  for (const requestHeaders of [{}, headers]) {
    assert.equal((await fetch(origin + legacyUi, { headers: requestHeaders })).status, 404);
  }

  anonymousCodes.ui = 404;

  const blocked = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`);
  const denied = await within(new Promise<number | undefined>((resolve, reject) => {
    blocked.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    blocked.once('open', () => reject(new Error('WebSocket открылся без сессии')));
    blocked.once('error', reject);
  }), 5000);

  assert.equal(denied, 401);
  anonymousCodes['/api/terminal'] = denied;
  blocked.terminate();

  const page = await fetch(origin, { headers: { Accept: 'text/html' } });

  assert.equal(page.status, 200);
  assert.match(await page.text(), /GrigDesk открывается в приложении/);

  const upstream = createUpstream({
    address: origin,
    windowKey: () => readFile('/D/window-auth/key', 'utf8'),
  });

  pipe = await startPipe({
    port: 0,
    uiDir: '/D/ui-source',
    secret: 'synthetic-sea-pipe-secret',
    appApi: API_VERSION,
    upstream,
  });

  const pipeHeaders = { cookie: 'grigdesk_pipe=synthetic-sea-pipe-secret' };
  const packagedUi = await fetch(pipe.origin, { headers: pipeHeaders });

  assert.equal((await fetch(pipe.origin)).status, 403);
  assert.equal(packagedUi.status, 200);
  assert.match(await packagedUi.text(), /sea-protocol-ui/);
  await upstream.probe();
  assert.equal(upstream.state().status, 'online', JSON.stringify(upstream.state()));

  const devices = await fetch(`${pipe.origin}/api/devices`, { headers: pipeHeaders });

  assert.equal(devices.status, 200);
  assert.deepEqual((await devices.json() as { devices: unknown[] }).devices, []);
  assert.equal(devices.headers.get('set-cookie'), null);

  const cli = tracked(path.join(root, 'bin/grigdesk-ctl'), ['device', 'list', '--json'], env);

  try {
    const cliExit = await within(cli.exited, 15000);

    assert.equal(cliExit.code, 0, cli.log());
    assert.deepEqual((JSON.parse(cli.log()) as { devices: unknown[] }).devices, []);
  } finally {
    await cli.stop();
  }

  const controller = new AbortController();
  const events = await fetch(`${origin}/api/events`, { headers, signal: controller.signal });

  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = events.body!.getReader();
  const first = await within(reader.read(), 5000);

  assert.match(new TextDecoder().decode(first.value), /event: hello/);
  controller.abort();
  await reader.cancel().catch(() => undefined);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`, { headers });
  let output = '';

  try {
    await within(new Promise<void>((resolve, reject) => {
      socket.once('open', () => socket.send(JSON.stringify({
        t: 'in',
        d: "printf '__GRIG''DESK_PTY_OK__\\n'\r",
      })));
      socket.on('message', (data) => {
        output += data.toString();

        if (output.includes('__GRIGDESK_PTY_OK__')) {
          resolve();
        }
      });
      socket.once('error', reject);
      socket.once('close', () => reject(new Error(`PTY закрылся без результата: ${output}`)));
    }), 10000);
  } finally {
    socket.close();

    if (socket.readyState !== WebSocket.CLOSED) {
      await within(once(socket, 'close'), 5000).catch(() => socket.terminate());
    }
  }

  const version = await (await fetch(`${origin}/api/system/version`, { headers })).json() as {
    updateCapability: { kind: string };
  };

  assert.equal(version.updateCapability.kind, 'package');

  for (const route of ['apply', 'update', 'web-rebuild']) {
    const response = await fetch(`${origin}/api/system/${route}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(route === 'web-rebuild' ? {} : {
        expectedCheckoutSha: 'a'.repeat(40), ...(route === 'update' ? { targetTag: 'v1.2.3' } : {}),
      }),
    });

    assert.equal(response.status, 409, route);
    assert.equal((await response.json() as { error: string }).error, 'packaged_update_requires_package');
  }

  assert.equal(existsSync('/D/state/update.json'), false);
  console.log(JSON.stringify({
    unauthorized: true,
    apiOnly: true,
    packagedPipeUi: true,
    pipeDevices: true,
    deviceCli: true,
    apiVersion: true,
    sessionSse: true,
    pythonPty: true,
    packageUpdateRejected: true,
    anonymousCodes,
  }));
} finally {
  await pipe?.close();

  const stopped = await run.stop();

  assert.equal(stopped.code, 0, run.log());
}
