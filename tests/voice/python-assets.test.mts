import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createScriptResolver } from '../../voice/src/python.ts';
import { fixtureRoot } from './helpers.mts';

test('voice-assets-параллельные-ресурсы-приватны-и-имеют-свой-cleanup', async (t) => {
  const root = await fixtureRoot(t);
  const options = {
    sea: true,
    asset: () => 'print("fixture")\n',
    temporaryRoot: root,
  };
  const first = createScriptResolver('/missing-source', options);
  const second = createScriptResolver('/missing-source', options);

  t.after(() => first.cleanup());
  t.after(() => second.cleanup());

  const [a, b] = await Promise.all([
    first.scriptPath('piperSynth.py'), second.scriptPath('piperSynth.py'),
  ]);

  assert.notEqual(a, b);
  assert.equal(await first.scriptPath('piperSynth.py'), a);
  assert.equal((await fs.stat(a)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(a))).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(a, 'utf8'), 'print("fixture")\n');
  await first.cleanup();
  await assert.rejects(fs.access(a), { code: 'ENOENT' });
  await assert.rejects(first.scriptPath('piperSynth.py'));
  assert.equal(await fs.readFile(b, 'utf8'), 'print("fixture")\n');
  await assert.rejects(second.scriptPath('../outside.py'));
});
