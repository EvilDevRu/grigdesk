import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { installationCandidate, MAC_APP_EXECUTABLE } from '../../shared/node/bundleLayout.ts';
import { materializeMacDesktop, verifyMacDesktopZip } from '../../shared/node/macosAppArchive.ts';
import { extractReleaseArtifact } from '../../shared/node/releaseArchive.ts';
import { verifyReleaseEnvelope } from '../../shared/node/releaseTrust.ts';
import {
  decodeReleaseChannelIndex, MAC_APP_ARCHIVE, MAC_APP_TREE,
} from '../../shared/runtime/installedUpdateContracts.ts';
import { writeStoredMacZip } from '../helpers/macosZipFixture.mjs';
import { sha256, signedMacIndex } from '../helpers/releaseV2Fixture.mjs';

const execute = promisify(execFile);
const linkName = 'grigdesk.app/Contents/Frameworks/Current';

/**
 * Опись подписывается после формирования фактических ZIP и ustar.
 * Оба слоя читаются production-портами, включая отказы после проверки подписи.
 */
async function signedArchive(t: TestContext, variant: 'clean' | 'absolute' | 'case' | 'unicode' | 'cycle') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-app-fixture-')));
  const stage = path.join(root, 'outer');
  const directory = path.join(root, 'desktop');
  const zip = path.join(stage, MAC_APP_ARCHIVE);
  const tar = path.join(root, 'desktop.tar.gz');
  const target = variant === 'absolute' ? '/outside' : variant === 'cycle' ? 'Current' : 'VersionA';
  const files = [{
    name: 'grigdesk.app/Contents/Frameworks/VersionA/resources',
    bytes: Buffer.from('fixture'),
  }, {
    name: 'grigdesk.app/Contents/Info.plist',
    bytes: Buffer.from('plist'),
  }, {
    name: MAC_APP_EXECUTABLE,
    bytes: Buffer.from('executable'),
  }];

  if (variant === 'case' || variant === 'unicode') {
    const aliases = variant === 'case' ? ['Alpha', 'alpha'] : ['café', 'cafe\u0301'];

    for (const name of aliases) {
      files.push({ name: `grigdesk.app/Contents/${name}`, bytes: Buffer.from(name) });
    }
  }

  const directories = ['grigdesk.app', 'grigdesk.app/Contents', 'grigdesk.app/Contents/Frameworks',
    'grigdesk.app/Contents/Frameworks/VersionA', 'grigdesk.app/Contents/MacOS'];
  const entries = [
    ...directories.map((relativePath) => ({ type: 'directory' as const, relativePath })),
    ...files.map(({ name, bytes }) => ({
      type: 'file' as const,
      relativePath: name,
      bytes: bytes.length,
      mode: name === MAC_APP_EXECUTABLE ? 0o755 : 0o644,
      sha256: sha256(bytes),
    })),
    {
      type: 'link' as const,
      relativePath: linkName,
      target,
    },
  ];

  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : 1);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(stage, { mode: 0o700 });
  await writeStoredMacZip(zip, [{
    name: linkName,
    bytes: target,
    mode: 0o120777,
  }, ...files.map((file) => ({
    ...file, mode: file.name === MAC_APP_EXECUTABLE ? 0o100755 : 0o100644,
  }))]);

  const tree = { format: 1 as const, entries };

  await fs.writeFile(path.join(stage, MAC_APP_TREE), canonicalJson(tree) + '\n', { mode: 0o444 });
  await execute('tar', ['--format=ustar', '-czf', tar, '-C', stage, MAC_APP_TREE, MAC_APP_ARCHIVE]);

  const inventory = [];

  for (const name of [MAC_APP_TREE, MAC_APP_ARCHIVE]) {
    const bytes = await fs.readFile(path.join(stage, name));

    inventory.push({
      path: name,
      size: bytes.length,
      sha256: sha256(bytes),
      mode: 0o444,
    });
  }

  const tarBytes = await fs.readFile(tar);
  const fixture = signedMacIndex({ desktop: {
    files: inventory,
    filesDigest: sha256(canonicalJson(inventory)),
    size: tarBytes.length,
    sha256: sha256(tarBytes),
    unpackedSize: inventory.reduce((sum, file) => sum + file.size, 0),
    unpackedBundleBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
  } });
  const envelope = decodeReleaseChannelIndex(fixture.index).latest!;
  const artifact = envelope.payload.artifacts.desktop;

  assert.equal(verifyReleaseEnvelope(envelope, fixture.publicKeyPem), fixture.manifestDigest);
  await extractReleaseArtifact(tar, directory, artifact);

  return {
    root,
    directory,
    artifact,
    tree,
  };
}

test('MAC-APP-ARCHIVE: preflight принимает относительный symlink framework', async (t) => {
  const fixture = await signedArchive(t, 'clean');

  await verifyMacDesktopZip(path.join(fixture.directory, MAC_APP_ARCHIVE), fixture.tree);

  const binary = path.join(fixture.root, 'generations/0.3.0/desktop', MAC_APP_EXECUTABLE);

  assert.equal(installationCandidate(binary, 'darwin'), fixture.root);
  assert.equal(installationCandidate(binary, 'linux'), null);
});

const rejected = {
  absolute: /release_mac_app_tree_invalid/u,
  case: /release_mac_app_path_invalid/u,
  unicode: /release_mac_app_path_invalid/u,
  cycle: /release_mac_app_link_cycle/u,
} as const;

for (const [variant, message] of Object.entries(rejected)) {
  test(`MAC-APP-ARCHIVE: signed ZIP ${variant} отклоняется до распаковки`, async (t) => {
    const fixture = await signedArchive(t, variant as keyof typeof rejected);

    await assert.rejects(materializeMacDesktop(fixture.directory, fixture.artifact), message);
    assert.deepEqual((await fs.readdir(fixture.directory)).sort(), [MAC_APP_TREE, MAC_APP_ARCHIVE]);
    await assert.rejects(fs.lstat(path.join(fixture.root, 'outside')), { code: 'ENOENT' });
  });
}
