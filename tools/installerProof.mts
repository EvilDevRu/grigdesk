import { createPublicKey, verify } from 'node:crypto';

import { RELEASE_SIGNING_PUBLIC_KEY } from '../shared/runtime/releaseChannelContracts.ts';
import type { ReleaseEnvelope } from '../shared/runtime/installedUpdateContracts.ts';
import { verifyReleaseEnvelope } from '../shared/node/releaseTrust.ts';
import { sha256File } from '../shared/node/hash.ts';

/**
 * Подпись installer связывает точные байты скрипта с уже проверенным конвертом
 * выпуска. Перенесено из installedPublication без изменения контракта.
 */
export async function verifyReleaseInstaller(
  binary: string,
  envelope: ReleaseEnvelope,
  proof: string,
  signature: string,
  publicKey: string = RELEASE_SIGNING_PUBLIC_KEY,
): Promise<void> {
  const digest = verifyReleaseEnvelope(envelope, publicKey);
  const installer = await sha256File(binary);
  const expected = `GrigDesk installer v1\n${installer}  grigdesk-install\n${digest}\n`;

  if (proof !== expected || !verify(null, Buffer.from(proof), createPublicKey(publicKey),
    Buffer.from(signature.trim(), 'base64'))) {
    throw new Error('release_installer_signature_invalid');
  }
}

