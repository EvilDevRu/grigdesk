import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { copyResources } from '../../server/scripts/sea/resources.mts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HELPER = 'server/src/lib/accessProfiles/authPty.py';

/**
 * Запускает копию поставляемого PTY и фиксирует только синтетический вывод ребёнка.
 * EOF без разрешающего байта моделирует смерть сервера до сохранения child identity.
 */
function runPty(file, permit) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [file, process.execPath, '-e', 'console.log("login-started")'], {
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      resolve({ code, output });
    });

    if (permit) {
      child.stdin.write(Buffer.from([0]));
    } else {
      child.stdin.end();
    }
  });
}

test('AP24_package: обе поставки включают работающий PTY с допуском до login', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'access-package-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const name of ['resources.json', 'binary-resources.json']) {
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'server/build', name), 'utf8'));
    const entries = manifest.entries.filter((entry) => entry.source === HELPER);
    const stage = path.join(root, name);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].target, HELPER);
    await copyResources(ROOT, stage, { schema: 1, entries });

    const helper = path.join(stage, HELPER);
    const denied = await runPty(helper, false);
    const allowed = await runPty(helper, true);

    assert.equal(denied.code, 0);
    assert.equal(denied.output, '');
    assert.equal(allowed.code, 0);
    assert.match(allowed.output, /login-started/u);
  }
});
