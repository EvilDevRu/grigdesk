import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { cockpitCliPath } from '../../server/src/lib/cliPath.ts';
import { routeLaunchEnv } from '../../server/src/lib/factoryRouteCli.ts';
import { openKnowledgeStorage } from '../../server/src/lib/search/storage.ts';
import { record } from './helpers/knowledge.js';

const exec = promisify(execFile);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const BASE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

/**
 * Проверяем настоящий CLI из чужого cwd с отдельной базой: установленный симлинк
 * и работающий сервер не участвуют в поиске команды и чтении записи.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'foreign-worktree');
  const dbPath = path.join(root, 'knowledge.db');
  await mkdir(cwd);
  const storage = await openKnowledgeStorage({ dbPath });
  let created;
  try {
    created = await storage.create(record({ tags: ['knowledge'] }));
  } finally {
    await storage.close();
  }

  return { cwd, dbPath, created };
}

test('launcher даёт knowledge в чистом PATH без установленного симлинка', async (t) => {
  const { cwd, dbPath, created } = await fixture(t);
  const { stdout } = await exec('bash', ['-c', String.raw`
set -euo pipefail
source "$1"
cockpit_add_cli_paths
exec knowledge read "$2"
`, 'knowledge-path-test', path.join(ROOT, 'bin/lib/runtime-env.sh'), created.id], {
    cwd,
    env: { ...process.env, PATH: BASE_PATH, COCKPIT_KNOWLEDGE_DB_PATH: dbPath },
  });

  assert.equal(JSON.parse(stdout).record.id, created.id);
});

test('окружение дочернего агента и transient-прогона находит CLI той же установки', async (t) => {
  const { cwd, dbPath, created } = await fixture(t);
  const environments = [
    { PATH: cockpitCliPath(ROOT, BASE_PATH), COCKPIT_KNOWLEDGE_DB_PATH: dbPath },
    routeLaunchEnv({ rootDir: ROOT, knowledgeDbPath: dbPath }),
  ];

  for (const env of environments) {
    const { stdout: command } = await exec('bash', ['-c', 'command -v knowledge'], { cwd, env });
    assert.equal(command.trim(), path.join(ROOT, 'bin/knowledge'));
    const { stdout } = await exec('knowledge', ['read', created.id], { cwd, env });
    assert.equal(JSON.parse(stdout).record.id, created.id);
  }
});

test('повторная подготовка PATH не накапливает bin и сохраняет каталог Node', () => {
  const first = cockpitCliPath(ROOT, BASE_PATH);

  assert.equal(cockpitCliPath(ROOT, first), first);
  assert.equal(first.split(path.delimiter).includes(path.dirname(process.execPath)), true);
});
