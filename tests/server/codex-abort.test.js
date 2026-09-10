import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import codex from '../../server/src/lib/executors/codex.ts';

test('Codex executor aborts the CLI and returns a stopped turn with the new session id', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-abort-'));
  const fake = path.join(dir, 'fake-codex');
  await writeFile(fake, `#!/bin/sh
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-from-stream"}'
exec sleep 30
`);
  await chmod(fake, 0o755);
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })));

  const ac = new AbortController();
  const run = codex.run({
    config: { codexBin: fake },
    message: 'test',
    cwd: dir,
    model: '',
    effort: '',
    sessionId: null,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 80);

  await assert.rejects(run, (err) => {
    assert.equal(err.stopped, true);
    assert.equal(err.message, 'Ход остановлен.');
    assert.equal(err.sessionId, 'thread-from-stream');
    return true;
  });
});
