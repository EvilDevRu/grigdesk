import assert from 'node:assert/strict';
import test from 'node:test';

import { deepSeekBuildInputs, glmRuntimeIdentity } from '../../deepseek/scripts/buildRuntime.mts';
import { verifyDeepSeekVendorMetadata } from '../../deepseek/scripts/deepseekVendorManifest.ts';
import { selectedDeepSeekVendor } from '../helpers/deepseekVendor.mts';

test('патч каталога GLM-5.4 входит в штатный снимок и отпечаток допуска', async () => {
  const vendorDir = selectedDeepSeekVendor();
  const manifest = await verifyDeepSeekVendorMetadata(vendorDir);
  const patch = manifest.patches.find((entry) => entry.path === 'glm54-catalog.patch');

  assert.ok(patch);

  const initial = process.env.GRIGDESK_DEEPSEEK_GLM_54_BACKPORT;

  try {
    delete process.env.GRIGDESK_DEEPSEEK_GLM_54_BACKPORT;

    const standard = await deepSeekBuildInputs(vendorDir);
    const identity = await glmRuntimeIdentity({ vendorDir });

    assert.ok(identity.llmPiAi?.patches.some((entry) => entry.path === patch.path
      && entry.sha256 === patch.sha256));

    process.env.GRIGDESK_DEEPSEEK_GLM_54_BACKPORT = '1';

    assert.deepEqual(await deepSeekBuildInputs(vendorDir), standard);
    assert.deepEqual(await glmRuntimeIdentity({ vendorDir }), identity);
  } finally {
    if (initial === undefined) {
      delete process.env.GRIGDESK_DEEPSEEK_GLM_54_BACKPORT;
    } else {
      process.env.GRIGDESK_DEEPSEEK_GLM_54_BACKPORT = initial;
    }
  }
});
