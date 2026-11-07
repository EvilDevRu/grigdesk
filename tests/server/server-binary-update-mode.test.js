import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PackagedReleaseService, PackagedUpdateManager, readPackagedIdentity,
  runtimePackageId } from '../../server/src/lib/packagedRelease.ts';

/**
 * Корень payload имеет canonical basename packageId, без git и release.json.
 * Identity reader внедряется тем же портом, которым пользуется packaged service.
 */
async function fixture(t, version = '0.1.0') {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'server-update-'));
  const packageId = 'a'.repeat(64);
  const root = path.join(temporary, packageId);
  const binary = path.join(temporary, 'server-elf');
  const bundleFile = path.join(root, 'server/payload.cjs');

  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(path.dirname(bundleFile), { recursive: true });
  await writeFile(bundleFile, 'fixture');
  await writeFile(binary, 'fixture');
  await writeFile(path.join(root, 'VERSION'), `${version}\n`, { mode: 0o444 });

  return {
    root,
    packageId,
    context: {
      mode: 'payload',
      bundleFile,
      binary,
    },
  };
}

test('SB19b: версия и packageId payload доступны без git и inner ELF', async (t) => {
  const input = await fixture(t);
  const service = new PackagedReleaseService(input.root,
    (root) => readPackagedIdentity(root, input.context));
  const status = await service.getStatus().catch(() => null);

  assert.equal(status?.running.version, '0.1.0');
  assert.equal(status.running.packageId, input.packageId);
  assert.equal(status.running.sha, input.packageId);
  assert.equal(status.canApplyCheckout, false);
  assert.equal(status.canInstallRelease, false);
  assert.deepEqual((await readdir(input.root)).sort(), ['VERSION', 'server']);
});

test('SB19b: packageId только у настроенного payload с canonical basename', async (t) => {
  const input = await fixture(t);

  assert.equal(runtimePackageId(input.context), input.packageId);
  assert.equal(runtimePackageId({
    mode: 'source',
    root: input.root,
    execPath: process.execPath,
  }), null);
  assert.equal(runtimePackageId({ mode: 'sea', execPath: input.context.binary }), null);
  assert.throws(() => runtimePackageId({ ...input.context,
    bundleFile: path.join(input.root, '../server/payload.cjs') }), /контекст|корень|packageId/);
});

test('SB19b: apply/update отказывают до worker и создания job', async (t) => {
  const input = await fixture(t);
  const manager = new PackagedUpdateManager({
    installRoot: input.root,
    statePath: path.join(input.root, 'package-update.json'),
    channel: { latest: async () => {
      return null;
    } },
  });

  await assert.rejects(manager.startApply({}), { code: 'packaged_update_requires_package', statusCode: 409 });
  await assert.rejects(manager.startUpdate({}), {
    code: 'packaged_update_requires_package',
    statusCode: 409,
  });
  assert.equal(await manager.getJob(), null);
});

test('SB-version: payload следующего выпуска читает защищённую продуктовую версию', async (t) => {
  const input = await fixture(t, '0.2.0');
  const identity = await readPackagedIdentity(input.root, input.context);

  assert.equal(identity.version, '0.2.0');
});
