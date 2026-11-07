import { createPublicKey, verify } from 'node:crypto';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../runtime/releaseChannelContracts.ts';
import type { ReleaseEnvelope } from '../runtime/installedUpdateContracts.ts';
import { sha256 } from './hash.ts';

/**
 * Domain separator отделяет подпись выпуска от других протоколов с тем же ключом.
 * Заключительный LF входит в подписанные байты и digest сохранённого задания.
 */
export function releaseSignedBytes(envelope: ReleaseEnvelope): Buffer {
  return Buffer.from(`GrigDesk release v2\n${canonicalJson(envelope.payload)}\n`, 'utf8');
}

/**
 * Доверие берётся только из приложения, а не из ответа сайта или renderer.
 * Помимо Ed25519 сверяется digest описи; исполнение файлов разрешается позднее.
 */
export function verifyReleaseEnvelope(
  envelope: ReleaseEnvelope,
  publicKeyPem = RELEASE_SIGNING_PUBLIC_KEY,
): string {
  if (!publicKeyPem.trim()) {
    throw Object.assign(new Error('release_signing_key_missing'), { code: 'release_signing_key_missing' });
  }

  try {
    const key = createPublicKey(publicKeyPem);
    const bytes = releaseSignedBytes(envelope);

    if (key.asymmetricKeyType !== 'ed25519'
      || !verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'))) {
      throw new Error('release_signature_invalid');
    }

    for (const artifact of Object.values(envelope.payload.artifacts)) {
      if (sha256(canonicalJson(artifact.files)) !== artifact.filesDigest) {
        throw new Error('release_files_digest_invalid');
      }
    }

    return sha256(bytes);
  } catch (error) {
    throw Object.assign(new Error('release_signature_invalid', { cause: error }), {
      code: 'release_signature_invalid',
    });
  }
}
