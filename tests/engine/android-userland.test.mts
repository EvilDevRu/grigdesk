import assert from 'node:assert/strict';
import test from 'node:test';

import { readAndroidUserland } from '../../tools/android/userland.mts';

test('ANDROID-USERLAND: движок получает несущие утилиты', () => {
  const inventory = readAndroidUserland();

  for (const name of ['bash', 'flock', 'timeout', 'nohup', 'git', 'python3']) {
    const entry = inventory.entries[name];

    assert.ok(entry, name);
    assert.equal(entry.libraryName, `lib${name}.so`);
    assert.deepEqual(entry.abis, ['arm64-v8a', 'x86_64']);

    for (const abi of entry.abis) {
      assert.match(entry.sha256ByAbi[abi], /^[a-f0-9]{64}$/u);
    }
  }

  assert.ok(inventory.bashVersionMajor >= 4);
});