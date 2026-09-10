// SSH-проба VPS: ключи хоста должны попасть в stdin `ssh-keygen`, иначе тот ждёт EOF
// бесконечно и форма навсегда остаётся на «стучимся…».
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { fingerprintHostKeys } from '../../server/src/lib/gateway/ssh.ts';

const execFileAsync = promisify(execFile);

test('GW-SSH-01: отпечаток host key вычисляется через stdin и проба завершается', { timeout: 5_000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-gateway-ssh-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const keyPath = path.join(temp, 'host_ed25519');
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);

  const publicKey = await fs.readFile(`${keyPath}.pub`, 'utf8');
  const [keyType, payload] = publicKey.trim().split(/\s+/);
  const { stdout: expectedLine } = await execFileAsync('ssh-keygen', ['-lf', `${keyPath}.pub`]);
  const expectedHash = expectedLine.trim().split(/\s+/)[1];

  const fingerprints = await fingerprintHostKeys(`203.0.113.10 ${keyType} ${payload}\n`);

  assert.deepEqual(fingerprints, [{ bits: 256, hash: expectedHash, type: 'ED25519' }]);
});
