import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReleaseEnvelope, ReleaseArtifact } from '../runtime/installedUpdateContracts.ts';
import { sha256File } from './hash.ts';
import { assertInstallationPath, readInstallationJson } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { verifyMacDesktop } from './macosAppArchive.ts';
import { assertReleasePlatform } from './releaseChannel.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';

/**
 * Полная опись проверяется до исполнения: обычные файлы, права, размеры, SHA и отсутствие лишних записей.
 * Проверка годится как для staging, так и для удержанного поколения перед rollback.
 */
export async function verifyComponent(
  receipt: InstallationReceipt, relative: string, artifact: ReleaseArtifact,
) {
  if (artifact.unpackedBundleBytes !== undefined) {
    await verifyMacDesktop(await assertInstallationPath(receipt.root, relative), artifact);

    return;
  }

  const expected = new Map(artifact.files.map((file) => [file.path, file]));
  const directories = [''];

  while (directories.length) {
    const directory = directories.pop()!;
    const full = await assertInstallationPath(receipt.root, relative + (directory ? '/' + directory : ''));

    for (const entry of await fs.readdir(full, { withFileTypes: true })) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        directories.push(name);
        continue;
      }

      const file = expected.get(name);
      const absolute = await assertInstallationPath(receipt.root, `${relative}/${name}`);
      const stat = await fs.lstat(absolute);

      if (!file || !stat.isFile() || stat.size !== file.size || await sha256File(absolute) !== file.sha256
        || (stat.mode & 0o777) !== (file.mode & 0o111 ? 0o555 : 0o444)) {
        throw new Error('release_staged_file_changed');
      }

      expected.delete(name);
    }
  }

  if (expected.size) {
    throw new Error('release_staged_file_missing');
  }
}

/**
 * Возврат к предыдущему выпуску использует его собственный подписанный manifest и опись.
 * Совпадение имени каталога не разрешает запускать повреждённый retained component.
 */
export async function verifyInstalledGeneration(
  receipt: InstallationReceipt, relative: string, component: 'desktop' | 'server', key?: string,
): Promise<ReleaseEnvelope> {
  const envelope = await readInstallationJson(receipt.root,
    `${path.posix.dirname(relative)}/release.json`) as ReleaseEnvelope;

  verifyReleaseEnvelope(envelope, key);
  await assertReleasePlatform(envelope.payload.platform);

  if (relative !== `generations/${envelope.payload.version}/${component}`) {
    throw new Error('release_generation_identity_invalid');
  }

  await verifyComponent(receipt, relative, envelope.payload.artifacts[component]);

  return envelope;
}
