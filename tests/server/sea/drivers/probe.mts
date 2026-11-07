import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';

const [root, source] = process.argv.slice(2);

assert.ok(root && source);

const sourceHidden = !existsSync(source) && !existsSync(path.dirname(source));
const externalNode = spawnSync('node', ['--version'], { encoding: 'utf8' });
const hostNodeStatus = externalNode.status;
let readOnly = false;

try {
  writeFileSync(`${root}/write-must-fail`, 'fixture');
} catch (error) {
  readOnly = (error as NodeJS.ErrnoException).code === 'EROFS';
}

const server = createServer((_request, response) => response.end('namespace-loopback'));

server.listen(0, '127.0.0.1');
await once(server, 'listening');

const port = (server.address() as { port: number }).port;
const body = await (await fetch(`http://127.0.0.1:${port}`)).text();

await new Promise<void>((resolve) => server.close(() => resolve()));
assert.equal(sourceHidden, true);
assert.equal(hostNodeStatus, 97, JSON.stringify({
  error: externalNode.error?.message,
  signal: externalNode.signal,
  stderr: externalNode.stderr,
  path: process.env.PATH,
  mode: statSync('/host-bin/node').mode & 0o777,
  uid: process.getuid?.(),
}));
assert.equal(readOnly, true);
assert.equal(body, 'namespace-loopback');
console.log(JSON.stringify({
  sourceHidden,
  hostNodeStatus,
  readOnly,
  node: process.version,
  loopback: true,
}));
