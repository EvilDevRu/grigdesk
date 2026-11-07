import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const packagePath = new URL('../../web/package.json', import.meta.url);
const runnerPath = fileURLToPath(new URL('../run-node-tests-safe.sh', import.meta.url));
const run = promisify(execFile);

// Web-файлы дороже серверных (happy-dom), поэтому worker-ов меньше; бюджет группы при
// этом считается по тому же правилу, что и на сервере: не меньше гигабайта на файл.
const PER_FILE_RSS_MB = 1024;
const MAX_CONCURRENCY = 8;

function parseBudget(command) {
  return {
    concurrency: Number(command.match(/--test-concurrency=(\d+)/u)?.[1] || 0),
    maxRssMb: Number(command.match(/NODE_TEST_MAX_RSS_MB=(\d+)/u)?.[1] || 0),
  };
}

test('web test runner ограничивает heap и держит RSS-бюджет под параллельные файлы', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const command = packageJson.scripts?.['test:components'] ?? '';

  assert.match(command, /NODE_TEST_HEAP_MB=1024(?:\s|$)/);
  assert.match(command, /run-node-tests-safe\.sh(?:\s|$)/);

  const { concurrency, maxRssMb } = parseBudget(command);
  assert.ok(concurrency >= 2, `файлы снова идут по одному (concurrency=${concurrency})`);
  assert.ok(concurrency <= MAX_CONCURRENCY, `слишком много worker-ов: ${concurrency}`);
  assert.ok(
    maxRssMb >= concurrency * PER_FILE_RSS_MB,
    `RSS-бюджет ${maxRssMb}MB мал для ${concurrency} файлов`,
  );
});

test('RSS watchdog добивает всю группу при external allocation вне V8 heap', async () => {
  await assert.rejects(
    run('bash', [
      runnerPath,
      '-e',
      'globalThis.hold = Buffer.alloc(96 * 1024 * 1024, 1); setInterval(() => {}, 1000)',
    ], {
      env: {
        ...process.env,
        NODE_TEST_HEAP_MB: '256',
        NODE_TEST_MAX_RSS_MB: '64',
      },
      timeout: 5_000,
    }),
    (error) => (
      error.code === 137
      && /RSS \d+KB превысил 65536KB/.test(error.stderr)
      && /peak-rss=/.test(error.stderr)
    ),
  );
});
