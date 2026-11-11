import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./helpers/shutdownDnsFixture.mjs', import.meta.url));

for (const mode of ['cancel', 'native', 'restart', 'launcher', 'network-orphan']) {
  test(`TCP DNS: ${mode}, только собственные процессы и повторный запуск`, {
    timeout: 65_000,
  }, async (t) => {
    try {
      await run('unshare', ['-Urnm', 'true']);
    } catch {
      t.skip('Нужны user/mount/network namespaces');

      return;
    }

    const artifacts = process.env.GRIGDESK_ARTIFACTS_DIR || path.join(os.tmpdir(), 'grigdesk-artifacts');

    await mkdir(path.join(artifacts, 'shutdown-checks'), { recursive: true });

    const root = await mkdtemp(path.join(artifacts, 'shutdown-checks/t-'));
    const result = await run('unshare', ['-Urnm', process.execPath, fixture, mode, root], {
      timeout: 60_000,
      env: { PATH: '/usr/sbin:/usr/bin:/bin' },
    }).catch((error) => {
      assert.fail(`${error.message}\n${error.stdout}\n${error.stderr}`);
    });

    t.diagnostic(`${mode}: ${result.stdout.trim()}`);
  });
}
