import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';

import type { BinaryIsolationPaths } from '../isolation.mts';

const paths = JSON.parse(process.argv[2]!) as BinaryIsolationPaths;
const prepared = JSON.parse(await readFile('/D/prepared-runtime.json', 'utf8'));
const absent = async (file: string) => access(file).then(() => false, () => true);
const awk = spawnSync('/bin/sh', ['-c', "printf '7\\n' | awk '{print $1 * 2}'"], {
  encoding: 'utf8',
});

assert.equal(awk.status, 0, 'Системный awk через /etc/alternatives должен работать в namespace');
assert.equal(awk.stdout.trim(), '14');
assert.equal(spawnSync('/usr/bin/nawk', ['BEGIN {print 21 * 2}'], { encoding: 'utf8' }).stdout.trim(), '42');
assert.equal(spawnSync('/usr/bin/which', ['awk'], { encoding: 'utf8' }).stdout.trim(), '/usr/bin/awk');
await assert.rejects(writeFile('/etc/alternatives/forbidden', 'forbidden'), { code: 'EROFS' });

assert.equal(prepared.root, paths.runtime);
assert.equal(prepared.node, process.execPath);
await assert.rejects(writeFile(`${paths.installation}/forbidden`, 'forbidden'), { code: 'EROFS' });
await assert.rejects(writeFile(paths.deepseek, 'forbidden'), { code: 'EROFS' });
await writeFile('/D/data-write-proof', 'fixture');

const hostNode = spawnSync('/host-bin/node', [], { encoding: 'utf8' });

assert.equal(await readFile('/D/host-node-attempts', 'utf8'), 'called\n');
await rm('/D/host-node-attempts');

console.log('BINARY_REPORT ' + JSON.stringify({
  sourceAbsent: await absent(paths.source),
  hostHomeAbsent: await absent(paths.hostHome),
  hostNodeCode: hostNode.status,
  installationReadOnly: true,
  deepseekReadOnly: true,
  dataWritable: await readFile('/D/data-write-proof', 'utf8') === 'fixture',
  node: process.execPath,
  nodeVersion: process.version,
  awk: awk.stdout.trim(),
}));
