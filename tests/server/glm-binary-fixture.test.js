import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { glmBinaryFixture } from '../helpers/glmBinary.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';

/**
 * Unit размещения не запускает metadata double: проверяется подготовка настоящего helper.
 * Runtime policy лежит вне системного tmp, который sandbox заменяет собственным tmpfs.
 */
test('GLM binary fixture оставляет home и hooks за пределами приватного /tmp sandbox', async (t) => {
  const candidate = { info: runtimeInfoFixture(), binary: '/unit-only/not-executed' };
  const runtime = await glmBinaryFixture(t, { pair: { a: candidate, b: candidate } });
  const relative = path.relative(os.tmpdir(), runtime.root);

  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    'Sandbox скрывает host /tmp: вынесенный туда policy-файл недоступен hook');
  assert.ok(runtime.config.glmRuntimeHome.startsWith(`${runtime.root}${path.sep}`));
});
