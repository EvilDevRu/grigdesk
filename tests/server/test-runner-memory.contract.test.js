import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packagePath = new URL('../../server/package.json', import.meta.url);

test('server test runner ограничивает heap, RSS process group и выполняет файлы по одному', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const command = packageJson.scripts?.test ?? '';

  assert.match(command, /NODE_TEST_HEAP_MB=1024(?:\s|$)/);
  assert.match(command, /NODE_TEST_MAX_RSS_MB=2048(?:\s|$)/);
  assert.match(command, /run-node-tests-safe\.sh(?:\s|$)/);
  assert.match(command, /--test-concurrency=1(?:\s|$)/);
});
