import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildBootstrapBinary } from '../../helpers/deepseekBootstrapBuild.mts';
import { artifactsPath } from '../../../shared/runtime/dataHome.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const run = promisify(execFile);

test('SEA из пути с пробелами запускает ESM worker и второй JS собственным обычным Node', {
  timeout: 180000,
}, async (t) => {
  const scratch = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'deepseek-bootstrap-tests');

  await mkdir(scratch, { recursive: true });

  const temporary = await mkdtemp(path.join(scratch, 'fixture-'));

  t.after(() => rm(temporary, { recursive: true, force: true }));

  const payload = path.join(temporary, 'sources');
  const outputFile = path.join(temporary, 'deepseek');
  const copiedDirectory = path.join(temporary, 'путь с пробелами');
  const cache = path.join(temporary, 'cache с пробелами');
  const pin = JSON.parse(await readFile(path.join(root, 'deepseek/build/node-runtime.json'), 'utf8'));

  await mkdir(payload);
  await mkdir(copiedDirectory);
  await writeFile(path.join(payload, 'second.mjs'), `
console.log(JSON.stringify({
  kind: 'ordinary-node',
  nodeVersion: process.versions.node,
  execPath: process.execPath,
}));
`);
  await writeFile(path.join(payload, 'worker.mjs'), `
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawnSync(process.execPath, [fileURLToPath(new URL('./second.mjs', import.meta.url))], {
  env: { PATH: '' },
  encoding: 'utf8',
});

if (child.status !== 0) {
  throw new Error('Второй JS не исполнился обычным Node: ' + child.stderr);
}

console.log(JSON.stringify({
  nodeVersion: process.versions.node,
  execPath: process.execPath,
  args: process.argv.slice(2),
  second: JSON.parse(child.stdout),
}));
`);
  await buildBootstrapBinary({
    payloadDirectory: payload,
    entry: 'worker.mjs',
    outputFile,
    workDirectory: path.join(temporary, 'build-cache'),
    nodeArchive: path.join(root, 'tracker/.cache', `node-v${pin.version}-${pin.platform}.tar.xz`),
  });

  const binary = path.join(copiedDirectory, 'deepseek');

  await copyFile(outputFile, binary);
  await rm(payload, { recursive: true });

  const result = await run(binary, ['--cache-dir', cache, 'один аргумент с пробелами'], {
    cwd: copiedDirectory,
    env: { PATH: '' },
    timeout: 20000,
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.stderr, '');
  assert.equal(parsed.nodeVersion, pin.version);
  assert.equal(parsed.execPath, path.join(cache, 'node'));
  assert.deepEqual(parsed.args, ['один аргумент с пробелами']);
  assert.deepEqual(parsed.second, {
    kind: 'ordinary-node',
    nodeVersion: pin.version,
    execPath: parsed.execPath,
  });
});
