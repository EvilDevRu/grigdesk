import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import {
  chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { refreshRepos } from '../../server/src/lib/gitRefresh.ts';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

/**
 * Репозиторий на чистом master с origin и обёртка git в PATH, которая пишет каждый
 * вызов в журнал: по журналу видно, сколько fetch на самом деле запустилось.
 */
async function countedRepo(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'git-refresh-')));
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'main');
  const bin = path.join(root, 'bin');
  const journal = path.join(root, 'git-calls.log');
  const realGit = (await exec('bash', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim();
  const previousPath = process.env.PATH;

  t.after(async () => {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });

  await git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  await git(root, 'clone', '-q', origin, main);
  await git(main, 'config', 'user.name', 'Fixture');
  await git(main, 'config', 'user.email', 'fixture@example.invalid');
  await git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(main, 'push', '-q', 'origin', 'master');
  await mkdir(bin);
  await writeFile(path.join(bin, 'git'), [
    '#!/bin/sh',
    `echo "$*" >> ${JSON.stringify(journal)}`,
    `exec ${JSON.stringify(realGit)} "$@"`,
  ].join('\n'));
  await chmod(path.join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${previousPath}`;

  const fetches = async () => (await readFile(journal, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => / fetch /.test(` ${line} `))
    .length;

  return { main, fetches };
}

test('одновременные обновления одного каталога ждут один fetch, ключ у каждого свой', async (t) => {
  const { main, fetches } = await countedRepo(t);

  const [triage, factory] = await Promise.all([
    refreshRepos([{ key: 'be', dir: main }]),
    refreshRepos([{ key: 'backend', dir: main }]),
  ]);

  assert.deepEqual({
    fetches: await fetches(),
    keys: [triage[0]?.key, factory[0]?.key],
    updated: [triage[0]?.updated, factory[0]?.updated],
  }, {
    fetches: 1,
    keys: ['be', 'backend'],
    updated: [true, true],
  });
});

test('свежий итог переиспользуется только со сроком годности', async (t) => {
  const { main, fetches } = await countedRepo(t);
  const repos = [{ key: 'be', dir: main }];

  await refreshRepos(repos);
  await refreshRepos(repos, { maxAgeMs: 60_000 });

  const reused = await fetches();

  await refreshRepos(repos);

  assert.deepEqual({
    reused,
    fresh: await fetches(),
  }, {
    reused: 1,
    fresh: 2,
  });
});
