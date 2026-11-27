import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

/**
 * Отсутствие подтверждает только ENOENT, включая удалённые каталоги.
 * Любая другая ошибка доступа должна оставаться видимой в проверке.
 */
async function absent(rel) {
  try {
    await lstat(new URL(rel, root));

    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return true;
  }
}

test('V1-ABS: модули v1, фикстуры контракта и helper facade отсутствуют', async () => {
  for (const rel of [
    'server/src/lib/mobile/mobileServer.ts',
    'server/src/lib/mobile/facade',
    'server/src/lib/mobile/contract.ts',
    'server/src/lib/mobile/mobileContractSchema.ts',
    'server/src/lib/mobile/mobileContract.schema.json',
    'server/src/lib/mobile/operations.ts',
    'server/src/lib/mobile/idempotency.ts',
    'server/src/lib/mobile/chatTurns.ts',
    'server/src/lib/mobile/actionTokens.ts',
    'tests/fixtures/mobile-contract',
    'tests/server/helpers/mobile-facade.js',
  ]) {
    assert.equal(await absent(rel), true, rel);
  }

  const seed = await readFile(new URL('tests/helpers/mobileSeed.mjs', root), 'utf8');

  assert.equal(seed.includes('registerMobileFacade'), false);
  assert.equal(seed.includes('actionTokens'), false);
  assert.equal(seed.includes('requestMobile'), false);
});
