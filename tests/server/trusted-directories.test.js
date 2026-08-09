import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PrefsStore } from '../../server/src/lib/prefs-store.js';
import claudeExecutor from '../../server/src/lib/executors/claude.js';
import codexExecutor from '../../server/src/lib/executors/codex.js';
import kimiExecutor from '../../server/src/lib/executors/kimi.js';
import ollamaExecutor from '../../server/src/lib/executors/ollama.js';
import {
  TrustedDirectoryInputError,
  normalizeStoredTrustedDirectories,
  validateTrustedDirectories,
} from '../../server/src/lib/trusted-directories.js';

test('исполнители объявляют фактическую поддержку доверенных каталогов', () => {
  assert.equal(claudeExecutor.trustedDirectories, true);
  assert.equal(codexExecutor.trustedDirectories, true);
  assert.equal(ollamaExecutor.trustedDirectories, true);
  assert.equal(kimiExecutor.trustedDirectories({ kimiLaunchMode: 'host' }), false);
  assert.equal(kimiExecutor.trustedDirectories({ kimiLaunchMode: 'contained' }), true);
});

test('доверенные каталоги канонизируются и не дублируются через симлинки', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-trusted-'));
  try {
    const directory = path.join(temp, 'workspace');
    const alias = path.join(temp, 'workspace-link');
    await fs.mkdir(directory);
    await fs.symlink(directory, alias);

    assert.deepEqual(
      await validateTrustedDirectories([directory, alias, `${directory}/`]),
      [directory],
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('доверенный путь должен быть существующим абсолютным каталогом, но не корнем', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-trusted-'));
  try {
    const file = path.join(temp, 'file.txt');
    await fs.writeFile(file, 'x');

    for (const value of [['relative'], ['/'], [file], [path.join(temp, 'missing')]]) {
      await assert.rejects(
        validateTrustedDirectories(value),
        TrustedDirectoryInputError,
      );
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('PrefsStore хранит только нормальный список доверенных каталогов', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-prefs-'));
  try {
    const prefs = new PrefsStore({ prefsPath: path.join(temp, 'prefs.json') });
    const directory = path.join(temp, 'workspace');
    prefs.write({
      trustedDirectories: [directory, directory, 'relative', '/', null],
    });
    assert.deepEqual(prefs.read().trustedDirectories, [directory]);
    assert.deepEqual(
      normalizeStoredTrustedDirectories([directory, `${directory}/`, 'relative']),
      [directory],
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
