import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { seaLaunchEnvironment } from '../../server/src/lib/seaLaunch.ts';

test('SEA-LAUNCH-ENV: ранние настройки файла переданы, env важнее, NODE_OPTIONS удалён', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-launch-env-'));
  const code = path.join(root, 'R');
  const home = path.join(root, 'home');
  const data = path.join(root, 'D');

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const directory of [code, home, data]) {
    await mkdir(directory);
  }

  const file = path.join(data, '.env');

  await writeFile(file, 'NODE_EXTRA_CA_CERTS=/fixture/ca.pem\nNODE_OPTIONS=--require=/bad/file.cjs\n');

  const env = { HOME: home, GRIGDESK_HOME: data };
  const result = seaLaunchEnvironment(code, env, home, true);

  assert.equal(result.NODE_EXTRA_CA_CERTS, '/fixture/ca.pem');
  assert.equal(Object.hasOwn(result, 'NODE_OPTIONS'), false);
  assert.deepEqual(env, { HOME: home, GRIGDESK_HOME: data });
  assert.equal(seaLaunchEnvironment(code, { ...env, NODE_EXTRA_CA_CERTS: '/parent/ca' }, home, true)
    .NODE_EXTRA_CA_CERTS, '/parent/ca');
  assert.equal(seaLaunchEnvironment(code, { ...env, GRIGDESK_HOME: '/bad D' }, home, false)
    .GRIGDESK_HOME, '/bad D');
  assert.match(await readFile(file, 'utf8'), /NODE_OPTIONS=/);
});

test('REVIEW-P1/P5: ручной SEA оставляет Node пользователя первым и выносит npm/Python из R', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-review-env-'));
  const root = path.join(base, 'R');
  const data = path.join(base, 'D');
  const nodeDir = path.join(root, 'runtime/node/bin');

  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(data);

  const env = seaLaunchEnvironment(root, {
    HOME: base,
    GRIGDESK_HOME: data,
    PATH: `${nodeDir}:/user-node/bin:/usr/bin`,
    npm_config_prefix: path.join(root, 'runtime/node'),
  }, base, true);

  assert.deepEqual(env.PATH.split(':'), ['/user-node/bin', '/usr/bin', nodeDir]);
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.npm_config_prefix, path.join(data, 'state/npm-global'));
});
