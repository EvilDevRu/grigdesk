import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packagePath = new URL('../../server/package.json', import.meta.url);

// Набор сочетает короткие проверки с тяжёлыми native-процессами и сборкой ELF.
// Два одновременных файла соответствуют CPU обычного CI runner; бюджет RSS общий
// на всю группу и должен учитывать каждый worker вместе с его дочерними процессами.
const PER_FILE_RSS_MB = 1024;
const MAX_CONCURRENCY = 8;

function parseBudget(command) {
  return {
    concurrency: Number(command.match(/--test-concurrency=(\d+)/u)?.[1] || 0),
    maxRssMb: Number(command.match(/NODE_TEST_MAX_RSS_MB=(\d+)/u)?.[1] || 0),
  };
}

test('server test runner ограничивает heap и держит RSS-бюджет под параллельные файлы', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const command = packageJson.scripts?.test ?? '';

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
