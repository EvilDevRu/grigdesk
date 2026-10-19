import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectSessionJournal,
  sessionJournalDirectory,
  sessionProjectKey,
} from '../../server/src/lib/deepseek/journal.ts';

test('journal preflight выбирает высшую canonical версию, включая legacy v0 и zstd', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-version-'));

  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const directory = sessionJournalDirectory(home, '/project', 'test-session');

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'session.jsonl'), 'legacy');
  await fs.writeFile(path.join(directory, 'session.v3.jsonl.zstd'), 'current');
  await fs.writeFile(path.join(directory, 'session.v99.jsonl'), 'future-unchanged');
  await fs.writeFile(path.join(directory, 'session.v099.jsonl'), 'noncanonical');
  await fs.writeFile(path.join(directory, 'session.v100.jsonl.tmp'), 'temporary');

  const future = await inspectSessionJournal(home, '/project', 'test-session', [0, 1, 2, 3]);

  assert.deepEqual(future, {
    state: 'incompatible',
    version: 99,
    file: path.join(directory, 'session.v99.jsonl'),
  });
  assert.equal(await fs.readFile(future.file, 'utf8'), 'future-unchanged');
  await fs.rm(future.file);

  const current = await inspectSessionJournal(home, '/project', 'test-session', [0, 1, 2, 3]);

  assert.equal(current.state, 'readable');
  assert.equal(current.version, 3);
  await fs.rm(current.file);

  const legacy = await inspectSessionJournal(home, '/project', 'test-session', [0]);

  assert.equal(legacy.state, 'readable');
  assert.equal(legacy.version, 0);
  assert.equal(path.basename(legacy.file), 'session.jsonl');
  assert.deepEqual(await inspectSessionJournal(home, '/project', 'missing', [3]), { state: 'missing' });
  assert.throws(() => sessionJournalDirectory(home, '/project', '../foreign'));
  assert.equal(sessionProjectKey('/project/a b'), '--project-a~0020b--');
});
