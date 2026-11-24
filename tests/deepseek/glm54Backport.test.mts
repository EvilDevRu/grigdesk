import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { deepSeekBuildInputs, glmRuntimeIdentity } from '../../deepseek/scripts/buildRuntime.mts';
import { prepareDeepSeekSync } from '../../deepseek/scripts/deepseekVendorManifest.ts';
import { createDeepSeekVendorFixture } from '../helpers/deepseekVendor.mts';

const toggle = 'GRIGDESK_DEEPSEEK_GLM_54_BACKPORT';
const patch = 'deepseek/build/optional-patches/glm54-models.patch';
const legacyCommit = 'c291e7961a515f6d7af9304e7fd1d257929aef26';

/**
 * Минимальный снимок с llm-pi-ai проверяет атрибуцию патча для legacy commit.
 * Идентичности в метаданных подменяются только в изолированной fixture без сборки исходников.
 */
async function backportFixture(t: TestContext) {
  const fixture = await createDeepSeekVendorFixture(t);
  const plugin = 'packages/llm/llm-pi-ai';

  await mkdir(path.join(fixture.sourceDir, plugin), { recursive: true });
  await writeFile(path.join(fixture.sourceDir, plugin, 'package.json'), '{"name":"fixture-llm-pi-ai"}\n');
  fixture.selection.roots.push({ path: plugin, reason: 'Опись плагина GLM' });

  const candidate = await prepareDeepSeekSync({ ...fixture, commit: await fixture.commit() });

  return candidate;
}

test('GLM-5.4 входит в ключ generation и допуск только при включении на закреплённом Harness', async (t) => {
  const { stagingDir: vendorDir, manifest } = await backportFixture(t);
  const lock = path.join(vendorDir, 'upstream.lock.json');
  const initial = process.env[toggle];

  t.after(() => {
    if (initial === undefined) {
      delete process.env[toggle];
    } else {
      process.env[toggle] = initial;
    }
  });

  delete process.env[toggle];
  await writeFile(lock, JSON.stringify({ ...manifest, commit: legacyCommit }));

  const standard = await deepSeekBuildInputs(vendorDir);
  const standardGlm = await glmRuntimeIdentity({ vendorDir });

  assert.equal(standard.hashes[patch], undefined);
  process.env[toggle] = '1';

  const enabled = await deepSeekBuildInputs(vendorDir);
  const enabledGlm = await glmRuntimeIdentity({ vendorDir });

  assert.match(enabled.hashes[patch] ?? '', /^[a-f0-9]{64}$/u);
  assert.ok(enabledGlm.llmPiAi?.patches.some((entry) => entry.path === patch
    && entry.sha256 === enabled.hashes[patch]));
  assert.notEqual(enabledGlm.inputIdentity.composition, standardGlm.inputIdentity.composition);

  const exclusions = [
    ['0.2.0', legacyCommit],
    ['0.2.3-alpha.2', '4b399c39a6d1479cd84ca591b4d7c88e24d38a96'],
    [manifest.version, manifest.commit],
  ];

  for (const [version, commit] of exclusions) {
    await writeFile(lock, JSON.stringify({
      ...manifest,
      version,
      commit,
    }));

    const excluded = await deepSeekBuildInputs(vendorDir);

    assert.deepEqual(excluded.hashes, standard.hashes);
  }
});
