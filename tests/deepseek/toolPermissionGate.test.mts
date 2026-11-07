import assert from 'node:assert/strict';
import test from 'node:test';

import { runToolPermissionRegistry } from '../helpers/deepseekToolRegistry.mts';

for (const scenario of [
  'allow', 'reject', 'abort', 'bypass', 'parallel', 'unavailable', 'throwing', 'hook-deny',
  'automatic', 'automatic-bash', 'automatic-hook-ask', 'automatic-hook-deny',
  'automatic-web-search', 'automatic-web-fetch', 'default-web-search', 'default-web-fetch',
  'readonly-web-search', 'readonly-web-fetch',
  'readonly-read', 'readonly-write', 'child', 'frozen-args',
  'swapped-agent', 'swapped-args', 'swapped-definition',
]) {
  test(`native registry: ${scenario} сохраняет решение до эффекта`, { timeout: 900_000 }, async () => {
    assert.equal(await runToolPermissionRegistry(scenario), 'registry-ok\n');
  });
}
