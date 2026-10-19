import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = new URL('../../tools/server-sea-check', import.meta.url).pathname;

/**
 * Порт npm фиксирует build/test команды без настоящей сборки и публикации.
 * Build-result содержит путь с пробелами; отказ сборки обязан остановить приёмку.
 */
async function fixture(t, failBuild = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-release-sea-check-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, 'bin/npm'), '#!/bin/bash\n'
    + 'printf "%s\\n" "$*" >> "$SEA_TRACE"\n'
    + 'if [[ "$*" == *build:sea* ]]; then\n'
    + '  if [[ "$SEA_FAIL_BUILD" == 1 ]]; then exit 7; fi\n'
    + '  while [[ "$1" != --out-dir ]]; do shift; done\n'
    + '  mkdir -p "$2"\n'
    + '  printf \'{"directory":"/tmp/release with spaces"}\\n\' > "$2/build-result.json"\n'
    + 'fi\n', { mode: 0o755 });

  return {
    root,
    env: {
      PATH: `${path.join(root, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      SEA_TRACE: path.join(root, 'trace'),
      SEA_FAIL_BUILD: failBuild ? '1' : '0',
    },
  };
}

test('SEA-RELEASE-CHECK-01: явный build затем весь SEA gate без публикации', async (t) => {
  const { root, env } = await fixture(t);

  await execute('bash', [script, path.join(root, 'out'), path.join(root, 'cache')], { env });

  const trace = (await readFile(path.join(root, 'trace'), 'utf8')).trim().split('\n');

  assert.equal(trace.length, 2);
  assert.match(trace[0], /run build:sea -- --out-dir .* --cache-dir /);
  assert.match(trace[1], /run test:sea -- --release-dir \/tmp\/release with spaces$/);
});

test('SEA-RELEASE-CHECK-02: провал build останавливает gate с его кодом', async (t) => {
  const { root, env } = await fixture(t, true);

  await assert.rejects(execute('bash', [script, path.join(root, 'out'), path.join(root, 'cache')], { env }),
    (error) => error.code === 7);
  assert.equal((await readFile(path.join(root, 'trace'), 'utf8')).trim().split('\n').length, 1);
});

test('REVIEW-P6: обычный preflight не вызывает SEA, отдельная команда остаётся явной', async (t) => {
  const { root, env } = await fixture(t);

  await mkdir(path.join(root, 'tools'));
  await mkdir(path.join(root, 'server'));
  await mkdir(path.join(root, 'web'));
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');

  for (const name of ['release-check', 'server-sea-check']) {
    await copyFile(new URL(`../../tools/${name}`, import.meta.url), path.join(root, 'tools', name));
  }

  await writeFile(path.join(root, 'bin/git'), '#!/bin/bash\nshift 2\ncase "$*" in\n'
    + '"branch --show-current") echo main;;\n'
    + '"show-ref --verify --quiet refs/tags/v0.1.0") exit 1;;\n'
    + '"ls-remote --heads origin refs/heads/main") printf "abc refs/heads/main\\n";;\n'
    + '"rev-parse HEAD") echo abc;;\nesac\n', { mode: 0o755 });
  await execute('bash', [path.join(root, 'tools/release-check')], {
    cwd: root,
    env: {
      ...env,
      GRIGDESK_SEA_RELEASE_DIR: path.join(root, 'out'),
      GRIGDESK_SEA_CACHE_DIR: path.join(root, 'cache'),
    },
  });

  const trace = (await readFile(path.join(root, 'trace'), 'utf8')).trim().split('\n');

  assert.equal(trace.some((line) => /build:sea|test:sea/.test(line)), false);
  assert.deepEqual(trace, ['test', 'test', 'run build']);
});
