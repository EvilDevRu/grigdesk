import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitPluginSource } from '../../server/src/lib/pluginInstall/gitSource.ts';
import { runCommand } from '../../server/src/lib/pluginInstall/runCommand.ts';

import { safeGitConfigDigest } from '../../server/src/lib/pluginInstall/gitMetadata.ts';
import { createPluginRepo, git } from './helpers/pluginRepo.js';

/**
 * Положительный контроль имеет deadline и закрытый stdin вне filter протокола Git.
 * Ошибка fixture не может оставить бесконечный cat, удерживающий тестовый процесс.
 */
function execute(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...options, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.stdin?.end();
  });
}

/**
 * Marker скрипт находится только в собственной fixture и не принимает внешние пути.
 * Положительный контроль запускает ту же опасную настройку реальным Git.
 */
async function markerScript(root, name) {
  const marker = path.join(root, `${name}.marker`);
  const script = path.join(root, `${name}.sh`);

  const output = name === 'smudge' ? 'cat'
    : name === 'textconv' ? 'cat "$1"'
      : name === 'fsmonitor' ? "printf 'token\\0/\\0'" : 'exit 0';

  await writeFile(script, `#!/bin/sh\nprintf x >> '${marker}'\n${output}\n`);
  await chmod(script, 0o700);

  return { marker, script };
}

test('GS10: policy не исполняет реальные Git handlers до preview', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-git-policy-'));
  const repo = await createPluginRepo(t);
  const markers = {};

  t.after(() => rm(root, { recursive: true, force: true }));

  for (const name of ['hook', 'smudge', 'fsmonitor', 'diff', 'textconv', 'template']) {
    markers[name] = await markerScript(root, name);
  }

  const template = path.join(root, 'template');

  await mkdir(path.join(template, 'hooks'), { recursive: true });
  await writeFile(path.join(template, 'hooks/post-checkout'),
    `#!/bin/sh\nprintf x >> '${markers.template.marker}'\n`);
  await chmod(path.join(template, 'hooks/post-checkout'), 0o700);

  const config = path.join(root, 'unsafe-config');

  await writeFile(config, `[filter "fixture"]\nsmudge = ${markers.smudge.script}\n`
    + `[core]\nfsmonitor = ${markers.fsmonitor.script}\n`
    + `[diff "fixture"]\ncommand = ${markers.diff.script}\ntextconv = ${markers.textconv.script}\n`);

  await repo.release('1.0.0', { files: {
    '.gitattributes': '*.txt filter=fixture diff=fixture\n',
    'data.txt': 'original\n',
    '.hooks/post-checkout': `#!/bin/sh\nprintf x >> '${markers.hook.marker}'\n`,
  } });
  await chmod(path.join(repo.work, '.hooks/post-checkout'), 0o700);
  await git(repo.work, 'add', '.hooks/post-checkout');
  await git(repo.work, 'commit', '-m', 'executable hook fixture');
  await git(repo.work, 'tag', '-f', '-a', 'v1.0.0', '-m', 'v1.0.0');
  await git(repo.work, 'push', '-f', 'origin', 'main', '--tags');

  const one = await git(repo.work, 'rev-parse', 'HEAD');
  const sha = await repo.release('1.1.0', { files: { 'data.txt': 'second\n' } });
  const unsafe = path.join(root, 'unsafe');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config,
  };

  await execute('/usr/bin/git', [
    'clone', '--branch=v1.0.0', '--template=' + template, '--', repo.url, unsafe,
  ], { env });
  assert.equal(await readFile(markers.smudge.marker, 'utf8'), 'x');
  assert.equal(await readFile(markers.template.marker, 'utf8'), 'x');
  await git(unsafe, 'config', 'core.hooksPath', '.hooks');
  await chmod(path.join(unsafe, '.hooks/post-checkout'), 0o700);
  await git(unsafe, 'checkout', '--detach', one);
  assert.equal(await readFile(markers.hook.marker, 'utf8'), 'x');
  await execute('/usr/bin/git', ['status', '--porcelain'], { cwd: unsafe, env });
  assert.ok((await readFile(markers.fsmonitor.marker, 'utf8')).length > 0);
  await writeFile(path.join(unsafe, 'data.txt'), 'changed\n');
  await execute('/usr/bin/git', ['-c', 'core.fsmonitor=false', 'diff', '--ext-diff'], { cwd: unsafe, env });
  assert.ok((await readFile(markers.diff.marker, 'utf8')).length > 0);
  await execute('/usr/bin/git', [
    '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--textconv',
  ], { cwd: unsafe, env });
  assert.ok((await readFile(markers.textconv.marker, 'utf8')).length > 0);

  for (const value of Object.values(markers)) {
    await rm(value.marker);
  }

  const source = new GitPluginSource({ baseEnv: env });
  const directory = path.join(root, 'safe');

  await source.fetch({
    url: repo.url,
    target: {
    version: '1.1.0',
    tag: 'v1.1.0',
    sha,
  },
    destination: directory,
  }).catch((error) => {
    assert.equal(error.code, 'package_unsupported');
  });
  await source.changes(directory, one, sha);
  await source.inspectInstalled(directory, {
    source: { kind: 'git', url: repo.url },
    version: '1.1.0',
    tag: 'v1.1.0',
    sha,
    installedAt: new Date().toISOString(),
    payloadDigest: 'a'.repeat(64),
    gitConfigDigest: await safeGitConfigDigest(directory),
    npmDirs: [],
  });

  for (const value of Object.values(markers)) {
    assert.equal(await readFile(value.marker, 'utf8').catch(() => null), null);
  }
});

test('GS11: env overrides и чужой parent repository не подменяют источник', async (t) => {
  const repo = await createPluginRepo(t);
  const sha = await repo.release('1.0.0');
  const hijack = await createPluginRepo(t, { id: 'other' });

  await hijack.release('1.0.0');

  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-git-env-'));
  const config = path.join(root, 'config');
  const trace = path.join(root, 'trace');

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(config, `[url "${hijack.url}"]\ninsteadOf = ${repo.url}\n`);

  const baseEnv = {
    HOME: root,
    PATH: '/usr/bin:/bin',
    GIT_DIR: path.join(hijack.work, '.git'),
    GIT_WORK_TREE: hijack.work,
    GIT_INDEX_FILE: path.join(root, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(hijack.work, '.git/objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(hijack.work, '.git/objects'),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: '/fixture-wrapper',
    GIT_SSH: '/fixture-wrapper',
    GIT_SSH_COMMAND: '/fixture-wrapper',
    GIT_ASKPASS: '/fixture-wrapper',
    SSH_ASKPASS: '/fixture-wrapper',
    GIT_TRACE: trace,
    GIT_EXTERNAL_DIFF: '/fixture-wrapper',
  };
  const source = new GitPluginSource({ baseEnv });
  const directory = path.join(hijack.work, 'nested/package');

  await mkdir(path.dirname(directory), { recursive: true });
  await assert.doesNotReject(source.fetch({
    url: repo.url,
    target: {
      version: '1.0.0',
      tag: 'v1.0.0',
      sha,
    },
    destination: directory,
  }));
  assert.equal(JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8')).id, 'demo');
  assert.equal(await git(directory, 'rev-parse', 'HEAD'), sha);
  assert.equal(await readFile(trace, 'utf8').catch(() => null), null);
});

test('GS12: private global config содержит только helper, SSH остаётся фиксированным', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-git-credentials-'));
  const config = path.join(root, 'trusted');
  const contents = '[credential "https://git.example.invalid"]\nhelper = !fixture-credential-helper\n'
    + '[url "ext::fixture-secret"]\ninsteadOf = https://git.example.invalid/\n'
    + '[filter "fixture"]\nsmudge = ./fixture-secret\n'
    + '[core]\nsshCommand = ./fixture-secret\n';
  let global = '';
  let observed = '';
  let ssh = '';
  let mode = 0;

  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(config, contents);

  const source = new GitPluginSource({
    baseEnv: { HOME: root, GIT_SSH_COMMAND: './fixture-secret' },
    credentialConfig: () => readFile(config, 'utf8'),
    run: async (_file, _args, options) => {
      global = options.env.GIT_CONFIG_GLOBAL;
      observed = await readFile(global, 'utf8');
      mode = (await stat(global)).mode & 0o777;
      ssh = options.env.GIT_SSH_COMMAND;

      return {
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: `${'a'.repeat(40)}\trefs/tags/v1.0.0`,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        workspaceLimitExceeded: false,
      };
    },
  });

  await source.listVersions('https://git.example.invalid/team/demo.git');
  assert.match(observed, /credential "https:\/\/git\.example\.invalid"/u);
  assert.match(observed, /helper = !fixture-credential-helper/u);
  assert.equal(observed.includes('fixture-secret'), false);
  assert.equal(mode, 0o600);
  assert.match(ssh, /BatchMode=yes/u);
  assert.match(ssh, /ConnectTimeout=20/u);
  assert.equal(ssh.includes('StrictHostKeyChecking=no'), false);
  assert.equal(await stat(global).then(() => true).catch(() => false), false);
});
