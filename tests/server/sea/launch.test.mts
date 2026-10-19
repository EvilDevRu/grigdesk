import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { helperFixture, runFile } from './helperFixture.mts';

test('SEA-LAUNCH-EXECVE: helper передаёт раннее окружение и заменяет себя без смены PID', async (t) => {
  const fixture = await helperFixture(t, ['launch-sea-server']);
  const home = path.join(fixture.temporary, 'home');
  const data = path.join(fixture.temporary, 'data');

  await mkdir(home);
  await mkdir(data);
  await writeFile(path.join(data, '.env'),
    'NODE_EXTRA_CA_CERTS=/fixture/cert.pem\nNODE_OPTIONS=--require=/fixture/missing.cjs\n');
  await writeFile(path.join(fixture.root, 'server/grigdesk-server'), [
    '#!/bin/bash',
    '[[ -z "${NODE_OPTIONS+x}" ]] || exit 42',
    'printf "%s\\n%s\\n" "$NODE_EXTRA_CA_CERTS" "$$"',
  ].join('\n'), { mode: 0o755 });

  const execution = runFile(fixture.node, [fixture.entry('launch-sea-server')], {
    cwd: '/',
    env: {
      HOME: home,
      GRIGDESK_HOME: data,
      NODE_OPTIONS: '--max-old-space-size=512',
    },
    timeout: 10000,
  });
  const pid = execution.child.pid;
  const result = await execution;

  assert.deepEqual(result.stdout.trim().split('\n'), ['/fixture/cert.pem', String(pid)]);
});
