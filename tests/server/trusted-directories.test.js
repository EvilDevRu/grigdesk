import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import claudeExecutor from '../../server/src/lib/executors/claude.ts';
import codexExecutor from '../../server/src/lib/executors/codex.ts';
import kimiExecutor from '../../server/src/lib/executors/kimi.ts';
import { resolveWorkdirCapability } from '../../server/src/lib/chat/workdir.ts';

test('адаптеры объявляют смену папки вместо общего доверенного доступа', async () => {
  for (const executor of [claudeExecutor, codexExecutor]) {
    assert.deepEqual(await resolveWorkdirCapability(executor, {}), { switch: 'resume', roots: 'multi' });
    assert.equal(Object.hasOwn(executor, 'trustedDirectories'), false);
  }

  assert.deepEqual(await resolveWorkdirCapability(kimiExecutor, { kimiLaunchMode: 'host' }), {
    switch: 'reseed', roots: 'single',
  });
  assert.deepEqual(await resolveWorkdirCapability(kimiExecutor, { kimiLaunchMode: 'contained' }), {
    switch: 'reseed', roots: 'multi',
  });
});

test('старые prefs читаются без trustedDirectories и удаляют ключ при следующей записи', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-prefs-'));

  t.after(() => fs.rm(temp, { recursive: true, force: true }));

  const prefsPath = path.join(temp, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath });
  const projects = { demo: { title: 'Проект', repos: [] } };

  await fs.writeFile(prefsPath, JSON.stringify({ trustedDirectories: [temp], projects }));

  assert.equal(Object.hasOwn(prefs.read(), 'trustedDirectories'), false);
  prefs.write({ showAllModels: true, trustedDirectories: [temp] });

  const stored = JSON.parse(await fs.readFile(prefsPath, 'utf8'));

  assert.equal(Object.hasOwn(stored, 'trustedDirectories'), false);
  assert.deepEqual(stored.projects, projects);
  assert.equal(stored.showAllModels, true);
});
