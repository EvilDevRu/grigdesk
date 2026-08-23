import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packagePath = new URL('../../web/package.json', import.meta.url);

test('web test runner ограничивает heap и число параллельных файлов', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const command = packageJson.scripts?.['test:components'] ?? '';

  assert.match(command, /--max-old-space-size=768(?:\s|$)/);
  assert.match(command, /--test-concurrency=4(?:\s|$)/);
});
