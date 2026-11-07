import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { writePersistentState } from '../../server/src/lib/grigDeskRelease.ts';

const exec = promisify(execFile);

/**
 * Git работает только внутри переданного одноразового репозитория.
 * Тот же helper используется историческими и binary update сценариями.
 */
export async function git(cwd: string, ...args: string[]) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

/**
 * Минимальный пакет позволяет настоящему npm ci отработать offline.
 * Зависимостей модели нет, web build пишет только fixture dist.
 */
async function writePackage(dir: string, name: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    private: true,
    type: 'module',
    ...(name === 'fixture-web' ? { scripts: { build: 'node build.js' } } : {}),
  }, null, 2)}\n`);
  await writeFile(path.join(dir, 'package-lock.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version: '1.0.0' } },
  }, null, 2)}\n`);
}

/**
 * Два настоящих коммита и локальный bare origin воспроизводят весь путь updater.
 * Restart и npm исполняются только внутри fixture, рабочий сервер не затрагивается.
 */
export async function fixtureRepository(
  temp: string,
  { brokenBuild = false, runtimeGate = null, binaryContract = false }: {
    brokenBuild?: boolean;
    runtimeGate?: string | null;
    binaryContract?: boolean;
  } = {},
) {
  const publisher = path.join(temp, 'publisher');
  const origin = path.join(temp, 'origin.git');
  const root = path.join(temp, 'work');

  await git(temp, 'init', '-b', 'main', publisher);
  await git(publisher, 'config', 'user.name', 'GrigDesk Test');
  await git(publisher, 'config', 'user.email', 'grigdesk@example.invalid');
  await writeFile(path.join(publisher, '.gitignore'), [
    'server/node_modules/', 'server/.state/', 'bin/', 'cache/', 'homes/',
    'web/node_modules/', 'web/dist/', '',
  ].join('\n'));
  await writeFile(path.join(publisher, 'VERSION'), '0.1.0\n');
  await writeFile(path.join(publisher, 'release.txt'), 'one\n');
  await mkdir(path.join(publisher, 'deploy'), { recursive: true });
  await writeFile(path.join(publisher, 'deploy', 'restart.sh'), [
    '#!/usr/bin/env bash',
    'mkdir -p server/.state',
    'touch server/.state/restarted',
    '',
  ].join('\n'));
  await writePackage(path.join(publisher, 'server'), 'fixture-server');
  await writePackage(path.join(publisher, 'web'), 'fixture-web');
  await writeFile(path.join(publisher, 'web', 'build.js'), [
    "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
    "await mkdir('dist', { recursive: true });",
    "const value = await readFile('../release.txt', 'utf8');",
    "await writeFile('dist/index.html', value);",
    '',
  ].join('\n'));
  await mkdir(path.join(publisher, 'tests', 'server'), { recursive: true });
  await writeFile(path.join(publisher, 'tests', 'server', 'grigdesk-release.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('fixture smoke', () => assert.equal(1, 1));",
    '',
  ].join('\n'));
  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-m', 'v0.1.0');

  const first = await git(publisher, 'rev-parse', 'HEAD');

  await git(publisher, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');

  await writeFile(path.join(publisher, 'VERSION'), '0.2.0\n');
  await writeFile(path.join(publisher, 'release.txt'), 'two\n');

  if (runtimeGate !== null) {
    const library = path.join(publisher, 'server', 'src', 'lib');

    await mkdir(library, { recursive: true });
    await writeFile(path.join(library, 'nodeVersion.ts'), runtimeGate);
    await writeFile(path.join(library, 'grigdesk-release.js'), await readFile(
      new URL('../../server/src/lib/grigDeskRelease.ts', import.meta.url),
    ));
    await writeFile(path.join(publisher, 'tests', 'server', 'grigdesk-release.test.js'), await readFile(
      new URL('../server/grigdesk-release.test.js', import.meta.url),
    ));
  }

  if (binaryContract) {
    await writeFile(path.join(publisher, 'server/deepseek-runtime-contract.json'), JSON.stringify({
      format: 1,
      publishContract: 2,
      mode: 'binary',
    }));
    await copyFile(new URL('../../server/deepseek-host-contract.json', import.meta.url),
      path.join(publisher, 'server/deepseek-host-contract.json'));

    const library = pathToFileURL(fileURLToPath(
      new URL('../../server/src/lib/grigDeskRelease.ts', import.meta.url),
    )).href;

    await writeFile(path.join(publisher, 'tests/server/grigdesk-release.test.js'), `
import { assertReleasePublishContract } from ${JSON.stringify(library)};
await assertReleasePublishContract(process.cwd(), process.env.GRIGDESK_RELEASE_PUBLISH_CONTRACT,
  { fullVerify:false });
`);
    await mkdir(path.join(publisher, 'server/scripts'), { recursive: true });
    await writeFile(path.join(publisher, 'server/scripts/prepareDeepSeekRuntime.mts'),
      "throw new Error('UPDATE_MUST_NOT_BUILD_HARNESS');\n");
  }

  if (brokenBuild) {
    await writeFile(path.join(publisher, 'web', 'build.js'),
      "throw new Error('fixture build failed');\n");
  }

  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-m', 'v0.2.0');

  const second = await git(publisher, 'rev-parse', 'HEAD');

  await git(publisher, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');

  await git(temp, 'init', '--bare', origin);
  await git(publisher, 'remote', 'add', 'origin', origin);
  await git(publisher, 'push', 'origin', 'main', '--tags');
  await git(temp, 'clone', '--branch', 'main', origin, root);
  await git(root, 'reset', '--hard', first);
  await git(root, 'tag', '-d', 'v0.2.0');
  await mkdir(path.join(root, 'server', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'web', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'server', 'node_modules', 'old.txt'), 'old\n');
  await writeFile(path.join(root, 'web', 'dist', 'index.html'), 'old\n');

  return {
    root,
    publisher,
    first,
    second,
  };
}

/**
 * Задание создаётся с настоящим owner lock и прежним checkout SHA.
 * Worker меняет этот state так же, как задание от API сервера.
 */
export async function queueJob(root: string, first: string, second: string) {
  const statePath = path.join(root, 'server', '.state', 'grigdesk-update.json');
  const id = randomUUID();
  const now = new Date().toISOString();

  await mkdir(`${statePath}.job-lock`, { recursive: true });
  await writeFile(path.join(`${statePath}.job-lock`, 'owner.json'), `${JSON.stringify({ id })}\n`);
  await writePersistentState(statePath, {
    releaseCheck: {
      latest: {
        version: '0.2.0',
        tag: 'v0.2.0',
        sha: second,
        url: null,
      },
      checkedAt: now,
      checkError: null,
    },
    job: {
      id,
      kind: 'update',
      status: 'queued',
      stage: 'queued',
      createdAt: now,
      updatedAt: now,
      targetSha: second,
      targetVersion: '0.2.0',
      targetTag: 'v0.2.0',
      expectedCheckoutSha: first,
      error: null,
    },
  });

  return { id, statePath };
}

/**
 * Задание создаётся с настоящим owner lock и прежним checkout SHA.
 * Worker меняет этот state так же, как задание от API сервера.
 */
export async function queueApply(root: string, sha: string) {
  const statePath = path.join(root, 'server', '.state', 'grigdesk-update.json');
  const id = randomUUID();
  const now = new Date().toISOString();

  await mkdir(`${statePath}.job-lock`, { recursive: true });
  await writeFile(path.join(`${statePath}.job-lock`, 'owner.json'), `${JSON.stringify({ id })}\n`);
  await writePersistentState(statePath, {
    job: {
      id,
      kind: 'apply',
      status: 'queued',
      stage: 'queued',
      createdAt: now,
      updatedAt: now,
      targetSha: sha,
      targetVersion: 'v0.1.0',
      targetTag: null,
      expectedCheckoutSha: sha,
      error: null,
    },
  });

  return { id, statePath };
}

