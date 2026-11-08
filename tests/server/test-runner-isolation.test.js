import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { shellQuote } from '../../shared/lib/shellQuote.ts';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');
const runner = path.join(repository, 'tests/run-node-tests-safe.sh');
const upstream = path.join(repository, 'tests/server/deepseek-upstream-update.test.js');
const benchmark = path.join(repository, 'tests/server/chat-list-benchmark.test.mjs');

/**
 * Настоящий Bash-сторож запускает наблюдаемый Node-stub вместо дорогих проверок.
 * Exclusive marker доказывает отсутствие перекрытия групп, trace сохраняет argv и heap.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-runner-isolation-'));
  const bin = path.join(root, 'bin');
  const stub = path.join(root, 'node.mjs');
  const trace = path.join(root, 'trace.jsonl');
  const regular = path.join(root, 'regular.test.js');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(bin);
  await writeFile(regular, '');
  await writeFile(stub, `
import { appendFileSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

if (args[0] === '-e') {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });

  process.exit(result.status ?? 1);
}

const lock = ${JSON.stringify(path.join(root, 'exclusive'))};
const descriptor = openSync(lock, 'wx');

appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args,
  heap: process.env.NODE_TEST_HEAP_MB }) + '\\n');
await new Promise(resolve => setTimeout(resolve, 30));
closeSync(descriptor);
unlinkSync(lock);
process.exitCode = args.includes(process.env.RUNNER_FIXTURE_FAILURE) ? 9 : 0;
`);
  await writeFile(path.join(bin, 'node'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(stub)} "$@"\n`, { mode: 0o755 });

  return {
    root,
    bin,
    trace,
    regular,
  };
}

test('сторож разделяет source-sync и обычные файлы, сохраняя оба результата', async (t) => {
  const f = await fixture(t);

  for (const failure of ['', f.regular, upstream]) {
    await rm(f.trace, { force: true });

    const result = await execute('bash', [runner, '--test', '--test-concurrency=2',
      f.regular, upstream], {
      env: {
        ...process.env,
        PATH: f.bin + path.delimiter + process.env.PATH,
        NODE_TEST_HEAP_MB: '1024',
        NODE_TEST_POLL_SECONDS: '0.01',
        RUNNER_FIXTURE_FAILURE: failure,
      },
      timeout: 15_000,
    }).then(() => 0, (error) => error.code);
    const calls = (await readFile(f.trace, 'utf8')).trim().split('\n').map(JSON.parse);

    assert.equal(result, failure ? 9 : 0);
    assert.deepEqual(calls.map((call) => call.args), [
      ['--test', '--test-concurrency=2', f.regular],
      ['--test', '--test-concurrency=2', upstream],
    ]);
    assert.deepEqual(calls.map((call) => call.heap), ['1024', '1024']);
  }
});

test('benchmark сохраняет отдельный heap и не пересекается с source-sync', async (t) => {
  const f = await fixture(t);

  await execute('bash', [runner, '--test', '--test-concurrency=2',
    f.regular, upstream, benchmark], {
    env: {
      ...process.env,
      PATH: f.bin + path.delimiter + process.env.PATH,
      NODE_TEST_HEAP_MB: '1024',
      NODE_TEST_POLL_SECONDS: '0.01',
      RUNNER_FIXTURE_FAILURE: '',
    },
    timeout: 15_000,
  });

  const calls = (await readFile(f.trace, 'utf8')).trim().split('\n').map(JSON.parse);

  assert.deepEqual(calls.map((call) => call.args.at(-1)), [f.regular, upstream, benchmark]);
  assert.deepEqual(calls.map((call) => call.heap), ['1024', '1024', '2048']);
});
