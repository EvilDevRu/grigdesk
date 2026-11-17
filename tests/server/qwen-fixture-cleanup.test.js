import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { qwenFixture } from '../helpers/qwenFixture.mjs';

test('Qwen fixture: живой писатель закрывается до удаления home и восстановления env', async (t) => {
  let root;
  let child;
  let stopped = false;
  const originalHome = process.env.HOME;

  t.after(() => child?.kill('SIGKILL'));

  await t.test('владелец живой сессии', async (session) => {
    const fixture = await qwenFixture(session);

    root = fixture.root;
    fixture.onCleanup(async () => {
      const exited = once(child, 'exit');

      child.kill('SIGTERM');
      await exited;
      assert.equal(process.env.HOME, fixture.home);
      await access(fixture.root);
      stopped = true;
    });

    const writer = path.join(fixture.root, 'writer.cjs');

    await writeFile(writer, [
      "const fs = require('node:fs');",
      "setInterval(() => fs.appendFileSync(process.argv[2], 'x'), 2);",
      "process.stdout.write('ready');",
    ].join('\n'));
    child = spawn(process.execPath, [writer, path.join(fixture.home, 'chat.jsonl')], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await once(child.stdout, 'data');
  });

  assert.equal(stopped, true);
  assert.equal(process.env.HOME, originalHome);
  await assert.rejects(access(root), { code: 'ENOENT' });
});
