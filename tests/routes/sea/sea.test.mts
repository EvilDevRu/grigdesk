import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildBinary } from '../../../routes/scripts/build.mts';
import { sha256File } from '../../../shared/node/hash.ts';
import { startHttpFixture } from '../../tracker/helpers/httpFixture.mts';
import { runProcess } from '../../tracker/helpers/processFixture.mts';

const packageDir = fileURLToPath(new URL('../../../routes/', import.meta.url));

test('SEA-ROUTES: самостоятельный ELF без Node, исходников и node_modules', {
  timeout: 900000,
}, async (t) => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'routes-sea-'));
  const supplied = process.env.GRIGDESK_ROUTES_TEST_BINARY;
  const outDir = path.join(work, 'out');
  const cacheDir = path.join(work, 'cache');

  t.after(() => rm(work, { recursive: true, force: true }));

  if (!supplied) {
    await mkdir(cacheDir, { recursive: true });

    const archive = 'node-v24.21.0-linux-x64.tar.xz';

    await copyFile(path.join(packageDir, '.cache', archive), path.join(cacheDir, archive));
    await buildBinary({ outDir, cacheDir });
  }

  const built = supplied ?? path.join(outDir, 'routes');
  const before = await sha256File(built);
  const binary = path.join(work, 'routes');

  await copyFile(built, binary);
  assert.equal((await stat(binary)).mode & 0o777, 0o755);

  const head = Buffer.alloc(4);
  const handle = await open(binary, 'r');

  try {
    await handle.read(head, 0, 4, 0);
  } finally {
    await handle.close();
  }

  assert.deepEqual([...head], [0x7f, 0x45, 0x4c, 0x46]);

  const env = {
    HOME: work,
    PATH: '',
    GRIGDESK_HOME: path.join(work, 'data'),
    NODE_OPTIONS: '--require=/несуществующий-файл.js',
  };

  for (const flag of ['--help', '--version', '--license']) {
    const result = await runProcess(t, binary, [flag], { env, cwd: work });
    const output = result.stdout.toString() + result.stderr.toString();

    assert.equal(result.code, 0, output);
    assert.ok(output.length > 0);

    if (flag === '--version') {
      assert.match(result.stdout.toString(), /^routes .* \(Node v24\.21\.0, linux x64\)\n$/);
    }

    if (flag === '--license') {
      assert.match(result.stdout.toString(), /Permission is hereby granted/);
    }
  }

  const server = await startHttpFixture(t, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"drafts":[]}');
  });
  const result = await runProcess(t, binary, ['list', 'demo'], {
    cwd: work,
    env: {
      ...env,
      GRIGDESK_BASE_URL: server.baseUrl,
      GRIGDESK_CLI_TOKEN: 'fixture-token',
    },
  });

  assert.equal(result.code, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), { drafts: [] });
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0]?.url, '/api/routes/demo/drafts');
  assert.equal(server.requests[0]?.headers['x-grigdesk-token'], 'fixture-token');
  assert.equal(await sha256File(built), before);
});
