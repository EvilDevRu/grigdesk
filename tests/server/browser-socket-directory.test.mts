import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, lstat, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareBrowserSocket } from '../../server/src/lib/browser/browserSocketDirectory.ts';

test('SD01: private physical path; regular/symlink/live listener не удаляются', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-socket-guard-'));
  const file = path.join(root, 'browser/relay.sock');

  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareBrowserSocket(file);
  assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);
  await writeFile(file, 'foreign');
  await assert.rejects(() => prepareBrowserSocket(file), /browser_socket_busy/u);
  assert.equal((await lstat(file)).isFile(), true);
  await rm(file);
  await symlink(path.join(root, 'target'), file);
  await assert.rejects(() => prepareBrowserSocket(file), /browser_socket_busy/u);
  await rm(file);

  const server = net.createServer((socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(file, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await assert.rejects(() => prepareBrowserSocket(file), /browser_socket_busy/u);
  assert.equal((await lstat(file)).isSocket(), true);
});
