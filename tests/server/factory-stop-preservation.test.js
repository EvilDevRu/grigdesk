import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { factoryDecisionFixture } from './helpers/factoryDecisionFixture.js';

for (const running of [true, false]) {
  test(`STOP-OPEN: ${running ? 'живой' : 'умерший'} прогон сохраняет открытую trusted attempt`,
    async (t) => {
      const f = await factoryDecisionFixture(t);
      const { registry } = await f.adapter.readRegistry('7');
      const before = await f.adapter.readTrustedAttempt('7', registry);
      const root = path.dirname(f.callsLog);
      const marker = path.join(root, 'stopped');
      const systemctl = path.join(root, 'bin', 'systemctl');
      const pointer = path.join(root, 'control', 'protocol-v2', 'tasks', 't7', 'active-attempt.json');
      const pointerBefore = await readFile(pointer, 'utf8');

      await writeFile(systemctl, '#!/usr/bin/env bash\n'
        + `printf '%s\\n' "$*" >> '${f.callsLog}'\n`
        + `touch '${marker}'\nexit 0\n`, { mode: 0o755 });
      t.mock.method(f.adapter, 'isDaemonAlive', () => running && !existsSync(marker));

      const response = await f.app.inject({ method: 'POST', url: '/api/tasks/7/stop' });
      const after = await f.adapter.readTrustedAttempt('7', registry);

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().outcome, running ? 'stopped' : 'not_running');
      assert.ok(before, 'Фикстура прочитана настоящим trusted reader');
      assert.deepEqual(after, before, 'К5: Stop не меняет ledger и identity открытой попытки');
      assert.equal(after.terminal, null);
      assert.equal(await readFile(pointer, 'utf8'), pointerBefore);

      const calls = existsSync(f.callsLog) ? await readFile(f.callsLog, 'utf8') : '';

      assert.equal(calls, running ? '--user stop factory-t7\n' : '');
      assert.doesNotMatch(calls, /abandon|close|down|resume|retry/);
    });
}
