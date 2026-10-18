import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitPluginSource } from '../../server/src/lib/pluginInstall/gitSource.ts';
import { runCommand } from '../../server/src/lib/pluginInstall/runCommand.ts';
import { liveGroupMembers } from '../../server/src/lib/pluginInstall/workerIdentity.ts';

import { createPluginRepo, git } from './helpers/pluginRepo.js';

test('GS1: настоящий Git возвращает annotated/lightweight tags и commit SHA', async (t) => {
  const repo = await createPluginRepo(t);
  const one = await repo.release('1.0.0');
  const two = await repo.release('1.1.0', { lightweight: true });
  const source = new GitPluginSource();
  const versions = await source.listVersions(repo.url);

  assert.deepEqual(versions, [
    {
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: two,
    },
    {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: one,
    },
  ]);
});

test('GS2: отсутствующий file repository возвращает source_unavailable', async () => {
  const source = new GitPluginSource();

  await assert.rejects(source.listVersions('file:///fixture-repo-does-not-exist'), {
    code: 'source_unavailable',
  });
});

test('GS3: fetch устанавливает точный HEAD, origin и detached checkout', async (t) => {
  const repo = await createPluginRepo(t);
  const sha = await repo.release('1.0.0');

  await repo.release('1.1.0');

  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-source-fetch-'));
  const destination = path.join(root, 'package');
  const source = new GitPluginSource();
  const progress = [];

  t.after(() => rm(root, { recursive: true, force: true }));

  await source.fetch({
    url: repo.url,
    target: {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha,
    },
    destination,
    onProgress: (value) => progress.push(value),
  });

  const manifest = await readFile(path.join(destination, 'plugin.json'), 'utf8').catch(() => '{}');

  assert.equal(JSON.parse(manifest).version, '1.0.0');
  assert.equal(await git(destination, 'rev-parse', 'HEAD'), sha);
  assert.equal(await git(destination, 'remote', 'get-url', 'origin'), repo.url);
  await assert.rejects(git(destination, 'symbolic-ref', '-q', 'HEAD'));
  assert.ok(progress.length > 0);
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, index) => value >= 0 && value <= 100
    && (index === 0 || value > progress[index - 1])));
});

test('GS4: сдвинутый после listing тег отвергнут до готового checkout', async (t) => {
  const repo = await createPluginRepo(t);
  const one = await repo.release('1.0.0');
  const source = new GitPluginSource();
  const [target] = await source.listVersions(repo.url);

  await repo.release('1.1.0');
  await git(repo.work, 'tag', '-f', 'v1.0.0');
  await git(repo.work, 'push', '-f', 'origin', 'refs/tags/v1.0.0');

  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-source-tag-moved-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(target.sha, one);
  await assert.rejects(source.fetch({
    url: repo.url,
    target,
    destination: path.join(root, 'package'),
  }), {
    code: 'checkout_mismatch',
  });
});

test('GS5: fetch отменяется до запуска и после наблюдаемого clone stderr', async (t) => {
  const repo = await createPluginRepo(t);
  const sha = await repo.release('1.0.0');
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-source-abort-'));
  const target = {
    version: '1.0.0',
    tag: 'v1.0.0',
    sha,
  };
  const before = new AbortController();

  t.after(() => rm(root, { recursive: true, force: true }));
  before.abort();

  await assert.rejects(new GitPluginSource().fetch({
    url: repo.url,
    target,
    destination: path.join(root, 'before'),
    signal: before.signal,
  }), { code: 'cancelled' });

  const during = new AbortController();
  const workers = [];
  const finished = [];
  let observed = false;
  const source = new GitPluginSource({
    run: (file, args, options) => runCommand(file, args, {
      ...options,
      ownership: {
        async started(worker) {
          workers.push(worker);
        },
        async finished(id) {
          finished.push(id);
        },
      },
      onStderr(chunk) {
        options.onStderr?.(chunk);

        if (args.includes('clone') && chunk.includes('Cloning into')) {
          observed = true;
          during.abort();
        }
      },
    }),
  });

  await assert.rejects(source.fetch({
    url: repo.url,
    target,
    destination: path.join(root, 'during'),
    signal: during.signal,
  }), { code: 'cancelled' });
  assert.equal(observed, true);
  assert.ok(workers.length > 0);
  assert.equal(finished.length, workers.length);

  for (const worker of workers) {
    assert.deepEqual(await liveGroupMembers(worker.pgid), []);
  }
});

test('GS6: changes возвращает commit и NUL paths; иной отказ не превращается в пустой diff', async (t) => {
  const repo = await createPluginRepo(t);
  const one = await repo.release('1.0.0');
  const two = await repo.release('1.1.0', { files: { 'server.js': 'export default async function () {}' } });
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-source-changes-'));
  const directory = path.join(root, 'package');
  const source = new GitPluginSource();

  t.after(() => rm(root, { recursive: true, force: true }));
  await source.fetch({
    url: repo.url,
    target: {
    version: '1.1.0',
    tag: 'v1.1.0',
    sha: two,
  },
    destination: directory,
  });

  const changes = await source.changes(directory, one, two);

  assert.equal(changes?.commits.length, 1);
  assert.equal(changes.commits[0].sha, two);
  assert.deepEqual(changes.files, [
    { status: 'M', path: 'plugin.json' },
    { status: 'A', path: 'server.js' },
  ]);
  assert.equal(await source.changes(directory, 'c'.repeat(40), two), null);

  const failing = new GitPluginSource({
    run: (file, args, options) => args.includes('diff')
      ? Promise.resolve({
        code: 1,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: 'fixture-failure fixture-secret',
        stdoutTruncated: false,
        stderrTruncated: false,
        workspaceLimitExceeded: false,
      })
      : runCommand(file, args, options),
  });

  await assert.rejects(failing.changes(directory, one, two), { code: 'source_failed' });
});

test('GS7: inspect не теряет tracked/new/ignored изменения и допускает generated npm', async (t) => {
  const repo = await createPluginRepo(t);
  const sha = await repo.release('1.0.0', { files: { '.gitignore': 'ignored.txt\nnode_modules/\n' } });
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-source-inspect-'));
  const directory = path.join(root, 'package');
  const source = new GitPluginSource();

  t.after(() => rm(root, { recursive: true, force: true }));
  await source.fetch({
    url: repo.url,
    target: {
    version: '1.0.0',
    tag: 'v1.0.0',
    sha,
  },
    destination: directory,
  });

  const configBytes = await readFile(path.join(directory, '.git/config'));
  const expected = {
    source: { kind: 'git', url: repo.url },
    version: '1.0.0',
    tag: 'v1.0.0',
    sha,
    installedAt: new Date().toISOString(),
    payloadDigest: 'a'.repeat(64),
    gitConfigDigest: createHash('sha256').update(configBytes).digest('hex'),
    npmDirs: ['.'],
  };

  await mkdir(path.join(directory, 'node_modules/demo'), { recursive: true });
  await writeFile(path.join(directory, 'node_modules/demo/index.js'), 'generated');
  assert.deepEqual(await source.inspectInstalled(directory, expected), { sha, modified: false });

  for (const file of ['plugin.json', 'new.txt', 'ignored.txt']) {
    const target = path.join(directory, file);
    const original = await readFile(target).catch(() => null);

    await writeFile(target, 'changed');
    assert.equal((await source.inspectInstalled(directory, expected)).modified, true);

    if (original) {
      await writeFile(target, original);
    } else {
      await rm(target);
    }
  }

  await rm(path.join(directory, 'node_modules/demo/index.js'));
  assert.equal((await source.inspectInstalled(directory, expected)).modified, false);
  await writeFile(path.join(directory, '.git/config'), '[core]\nfsmonitor=fixture-secret\n');
  assert.equal((await source.inspectInstalled(directory, expected)).modified, true);
});

test('GS8: недопустимый URL не запускает ни одну команду source', async () => {
  let calls = 0;
  const source = new GitPluginSource({
    run: async () => {
      calls += 1;

      throw new Error('Команда не должна запускаться');
    },
  });

  await assert.rejects(source.listVersions('ext::fixture-secret'), { code: 'source_url_invalid' });
  await assert.rejects(source.fetch({
    url: 'https://user:fixture-secret@git.example.invalid/demo',
    target: {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: 'a'.repeat(40),
    },
    destination: '/fixture-unused',
  }), { code: 'source_url_invalid' });
  assert.equal(calls, 0);
});

test('GS9: tag не подменяется одноимённой веткой; blob tag не достигает checkout', async (t) => {
  const repo = await createPluginRepo(t);
  const one = await repo.release('1.0.0');
  const two = await repo.release('1.1.0');

  await git(repo.work, 'branch', 'v1.0.0', two);
  await git(repo.work, 'push', 'origin', 'refs/heads/v1.0.0:refs/heads/v1.0.0');

  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-source-ref-kind-'));
  const source = new GitPluginSource();
  const directory = path.join(root, 'tag');

  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.doesNotReject(source.fetch({
    url: repo.url,
    target: {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha: one,
    },
    destination: directory,
  }));
  assert.equal(await git(directory, 'rev-parse', 'HEAD'), one);

  const blob = await git(repo.work, 'rev-parse', 'HEAD:plugin.json');

  await git(repo.work, 'tag', 'v2.0.0', blob);
  await git(repo.work, 'push', 'origin', 'refs/tags/v2.0.0');

  const rejected = path.join(root, 'blob');

  await assert.rejects(source.fetch({
    url: repo.url,
    target: {
      version: '2.0.0',
      tag: 'v2.0.0',
      sha: blob,
    },
    destination: rejected,
  }));
  assert.equal(await lstat(path.join(rejected, 'plugin.json')).catch(() => null), null);
});

test('GS13: Git tree отклоняет gitlink без gitmodules и symlink до checkout', async (t) => {
  for (const mode of ['gitlink', 'symlink']) {
    const repo = await createPluginRepo(t);
    const initial = await repo.release('1.0.0');

    if (mode === 'gitlink') {
      await git(repo.work, 'update-index', '--add', '--cacheinfo', `160000,${initial},linked`);
    } else {
      await symlink('/fixture-secret', path.join(repo.work, 'linked'));
      await git(repo.work, 'add', 'linked');
    }

    await git(repo.work, 'commit', '-m', mode);
    await git(repo.work, 'tag', '-f', 'v1.0.0');
    await git(repo.work, 'push', '-f', 'origin', 'main', '--tags');

    const sha = await git(repo.work, 'rev-parse', 'HEAD');
    const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-git-tree-modes-'));
    const directory = path.join(root, 'package');
    const source = new GitPluginSource({
      run: (file, args, options) => runCommand(file, ['-c', 'core.symlinks=false', ...args], options),
    });

    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(source.fetch({
      url: repo.url,
      target: {
        version: '1.0.0',
        tag: 'v1.0.0',
        sha,
      },
      destination: directory,
    }), { code: mode === 'gitlink' ? 'submodules_forbidden' : 'symlink_forbidden' });
    assert.equal(await lstat(path.join(directory, 'plugin.json')).catch(() => null), null);
  }
});

test('GS14: filters/LFS и управляющие файлы отвергаются до materialization', async (t) => {
  for (const [file, body] of [
    ['.gitattributes', '*.txt filter=fixture\n'],
    ['.gitattributes', '*.txt working-tree-encoding=UTF-16\n'],
    ['large.dat', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n'],
    ['.npmrc', 'git=./fixture-wrapper\n'],
    ['npm-shrinkwrap.json', '{}'],
    ['node_modules/pkg/index.js', 'prebuilt'],
  ]) {
    const repo = await createPluginRepo(t);
    const sha = await repo.release('1.0.0', { files: { [file]: body } });
    const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-git-control-files-'));
    const directory = path.join(root, 'package');
    const source = new GitPluginSource();

    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(source.fetch({
      url: repo.url,
      target: {
        version: '1.0.0',
        tag: 'v1.0.0',
        sha,
      },
      destination: directory,
    }), { code: 'package_unsupported' });
    assert.equal(await lstat(path.join(directory, 'plugin.json')).catch(() => null), null);
  }
});

test('GS15: tree limits и полный history budget отклоняют пакет до materialization', async (t) => {
  const repo = await createPluginRepo(t);
  const sha = await repo.release('1.0.0', { files: { 'one.txt': 'x', 'two.txt': 'y' } });

  for (const limits of [
    {
      maxFiles: 2,
      maxBytes: 100000,
      maxManifestBytes: 65536,
    },
    {
      maxFiles: 5000,
      maxBytes: 10,
      maxManifestBytes: 65536,
    },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-tree-limits-'));
    const directory = path.join(root, 'package');
    const source = new GitPluginSource({ packageLimits: limits });

    t.after(() => rm(root, { recursive: true, force: true }));
    await assert.rejects(source.fetch({
      url: repo.url,
      target: {
        version: '1.0.0',
        tag: 'v1.0.0',
        sha,
      },
      destination: directory,
    }), {
      code: 'package_too_large',
    });
    assert.equal(await lstat(path.join(directory, 'plugin.json')).catch(() => null), null);
  }

  const historical = await createPluginRepo(t);

  await historical.release('1.0.0');
  await writeFile(path.join(historical.work, 'history.bin'), randomBytes(256 * 1024));
  await git(historical.work, 'add', 'history.bin');
  await git(historical.work, 'commit', '-m', 'large history');
  await rm(path.join(historical.work, 'history.bin'));

  const latest = await historical.release('1.1.0');
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-history-budget-'));
  const job = path.join(root, 'job');
  const untouched = path.join(root, 'current');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(job);
  await writeFile(untouched, 'original');
  await assert.rejects(new GitPluginSource().fetch({
    url: historical.url,
    target: {
      version: '1.1.0',
      tag: 'v1.1.0',
      sha: latest,
    },
    destination: path.join(job, 'package'),
    workspaceBudget: {
      root: job,
      maxBytes: 64 * 1024,
      minFreeBytes: 0,
      checkIntervalMs: 5,
    },
  }), { code: 'workspace_limit' });
  assert.equal(await readFile(untouched, 'utf8'), 'original');
});

test('GS16: история и diff сокращаются честно; source отвергает обрезанные refs/status', async (t) => {
  const repo = await createPluginRepo(t);
  const one = await repo.release('1.0.0');
  const files = {};
  const special = 'a-русский\tпуть\nимя.txt';

  for (let index = 0; index < 201; index += 1) {
    files[`files/${index}.txt`] = 'data';
  }

  files[special] = 'special';

  const two = await repo.release('1.1.0', { files });

  for (let index = 0; index < 50; index += 1) {
    await git(repo.work, 'commit', '--allow-empty', '-m', `history ${index}`);
  }

  const latest = await git(repo.work, 'rev-parse', 'HEAD');

  await git(repo.work, 'tag', '-f', 'v1.1.0');
  await git(repo.work, 'push', '-f', 'origin', 'main', '--tags');

  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-source-output-'));
  const directory = path.join(root, 'package');
  const source = new GitPluginSource({
    run: async (file, args, options) => {
      const result = await runCommand(file, args, options);

      if (result.code !== 0) {
        process.stdout.write('Диагностика собственной fixture: ' + JSON.stringify({ args, result }) + '\n');
      }

      return result;
    },
  });

  t.after(() => rm(root, { recursive: true, force: true }));
  await source.fetch({
    url: repo.url,
    target: {
    version: '1.1.0',
    tag: 'v1.1.0',
    sha: latest,
  },
    destination: directory,
  });

  const changes = await source.changes(directory, one, latest);

  assert.equal(changes.commits.length, 50);
  assert.equal(changes.files.length, 200);
  assert.equal(changes.truncated, true);

  const exact = await source.changes(directory, one, two);
  const specialPath = exact.files.find((entry) => entry.path === special);

  assert.equal(Boolean(specialPath), true);

  const truncated = new GitPluginSource({
    run: async (file, args, options) => {
      const result = await runCommand(file, args, options);

      if (args.includes('ls-remote') || args.includes('status')) {
        result.stdoutTruncated = true;
      }

      return result;
    },
  });

  await assert.rejects(truncated.listVersions(repo.url), { code: 'command_output_limit' });
  await assert.rejects(truncated.inspectInstalled(directory, {
    source: { kind: 'git', url: repo.url },
    version: '1.1.0',
    tag: 'v1.1.0',
    sha: latest,
    installedAt: new Date().toISOString(),
    payloadDigest: 'a'.repeat(64),
    gitConfigDigest: createHash('sha256')
      .update(await readFile(path.join(directory, '.git/config'))).digest('hex'),
    npmDirs: [],
  }), { code: 'command_output_limit' });
});

test('GS17: .git file/symlink и неизвестная metadata проверяются без Git', async (t) => {
  const repo = await createPluginRepo(t);
  const sha = await repo.release('1.0.0');
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-git-metadata-'));
  const directory = path.join(root, 'package');
  const calls = [];
  const source = new GitPluginSource({
    run: (file, args, options) => {
      calls.push(args);

      return runCommand(file, args, options);
    },
  });

  t.after(() => rm(root, { recursive: true, force: true }));
  await source.fetch({
    url: repo.url,
    target: {
    version: '1.0.0',
    tag: 'v1.0.0',
    sha,
  },
    destination: directory,
  });

  const original = await readFile(path.join(directory, '.git/config'));
  const expected = {
    source: { kind: 'git', url: repo.url },
    version: '1.0.0',
    tag: 'v1.0.0',
    sha,
    installedAt: new Date().toISOString(),
    payloadDigest: 'a'.repeat(64),
    gitConfigDigest: createHash('sha256').update(original).digest('hex'),
    npmDirs: [],
  };

  const modes = ['file', 'symlink', 'config.worktree', 'objects/info/alternates', 'info/grafts', 'config'];

  for (const mode of modes) {
    calls.length = 0;

    if (mode === 'file' || mode === 'symlink') {
      await rename(path.join(directory, '.git'), path.join(directory, '.git-safe'));

      if (mode === 'file') {
        await writeFile(path.join(directory, '.git'), 'gitdir: .git-safe\n');
      } else {
        await symlink('.git-safe', path.join(directory, '.git'));
      }
    } else {
      await mkdir(path.dirname(path.join(directory, '.git', mode)), { recursive: true });
      await writeFile(path.join(directory, '.git', mode), mode === 'config'
        ? original.toString() + '[core]\nfsmonitor = ./fixture-secret\n' : 'fixture');
    }

    assert.equal((await source.inspectInstalled(directory, expected)).modified, true);
    assert.equal(calls.length, 0, mode);

    if (mode === 'file' || mode === 'symlink') {
      await rm(path.join(directory, '.git'));
      await rename(path.join(directory, '.git-safe'), path.join(directory, '.git'));
    } else if (mode === 'config') {
      await writeFile(path.join(directory, '.git/config'), original);
    } else {
      await rm(path.join(directory, '.git', mode));
    }
  }
});
