import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Запуск проверяется в отдельном каталоге без Cockpit и Docker хоста. `node` в PATH
 * подменён обёрткой того же рантайма: фикстура должна видеть ровно тот Node, которым
 * идёт прогон, а не случайный из системного PATH. Флагов обёртка не добавляет —
 * минимум 22.18 исполняет TypeScript сам, и проверяется именно это.
 */
async function fixture(t, { stubNpm = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'docker-ts-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const relative of [
    'bin/lib', 'tools', 'server/src', 'server/scripts', 'server/node_modules', 'web/node_modules',
  ]) {
    await mkdir(path.join(directory, relative), { recursive: true });
  }
  await copyFile(path.join(root, 'bin/cockpit'), path.join(directory, 'bin/cockpit'));
  await copyFile(path.join(root, 'bin/lib/runtime-env.sh'), path.join(directory, 'bin/lib/runtime-env.sh'));
  await writeFile(path.join(directory, 'tools/node'), [
    '#!/usr/bin/env bash',
    `exec ${shellQuote(process.execPath)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  await writeFile(path.join(directory, 'tools/ss'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (stubNpm) {
    await writeFile(path.join(directory, 'tools/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const packageJson = JSON.parse(await readFile(path.join(root, 'server/package.json'), 'utf8'));
  await writeFile(path.join(directory, 'server/package.json'), JSON.stringify({
    private: true,
    type: 'module',
    scripts: { start: packageJson.scripts.start },
  }));
  const serviceUrl = new URL('../../server/src/lib/docker/service.ts', import.meta.url).href;
  const moduleUrl = new URL('../../server/src/modules/docker/index.ts', import.meta.url).href;
  // Лаунчеры репозитория указывают на `app.ts`: боевая сборка сервера живёт там,
  // а `app.js` остался однострочным shim-ом установленного юнита.
  await writeFile(path.join(directory, 'server/src/app.ts'), [
    "import { writeFile } from 'node:fs/promises';",
    `import { createDockerService } from ${JSON.stringify(serviceUrl)};`,
    `import dockerModule from ${JSON.stringify(moduleUrl)};`,
    'const service = createDockerService();',
    'await writeFile(process.env.DOCKER_TS_LAUNCH_PROOF, JSON.stringify({',
    '  overview: typeof service.overview,',
    '  module: typeof dockerModule,',
    '}));',
    '',
  ].join('\n'));

  const proof = path.join(directory, 'proof.json');
  const env = {
    ...process.env,
    PATH: `${path.join(directory, 'tools')}:${process.env.PATH || ''}`,
    DOCKER_TS_LAUNCH_PROOF: proof,
  };

  return {
    directory,
    proof,
    env,
  };
}

test('bin/cockpit запускает TS Docker без отдельной компиляции и без флагов', async (t) => {
  const { directory, proof, env } = await fixture(t, { stubNpm: true });

  await execute('bash', [path.join(directory, 'bin/cockpit'), 'run'], {
    cwd: directory,
    env,
    timeout: 10000,
  });

  assert.deepEqual(JSON.parse(await readFile(proof, 'utf8')), {
    overview: 'function',
    module: 'function',
  });
});

test('npm start загружает TS Docker без отдельной компиляции сервера', async (t) => {
  const { directory, proof, env } = await fixture(t);

  await execute('npm', ['--prefix', path.join(directory, 'server'), 'start'], {
    cwd: directory,
    env,
    timeout: 10000,
  });

  assert.deepEqual(JSON.parse(await readFile(proof, 'utf8')), {
    overview: 'function',
    module: 'function',
  });
});
