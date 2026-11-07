import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { readGigaCodeCredentialSnapshot } from './auth.ts';
import type { GigaCodeConfig } from './contract.ts';
import { GIGACODE_DISTRIBUTION_VERSION } from './contract.ts';
import { resolveGigaCodeInstallation } from './discovery.ts';
import { readGigaCodeMetadata } from './runtime.ts';

/**
 * Cache key учитывает установку, аккаунт и revision управляемого профиля.
 * В persisted metadata попадает только хэш; токен и native config не сериализуются.
 */
export async function gigaCodeCatalogCacheKey(config: GigaCodeConfig): Promise<string> {
  const installation = await resolveGigaCodeInstallation(config);
  const stat = await fs.stat(installation.bin);
  const snapshot = await readGigaCodeCredentialSnapshot(config);

  return createHash('sha256').update(JSON.stringify({
    version: GIGACODE_DISTRIBUTION_VERSION,
    profile: 1,
    bin: installation.bin,
    size: stat.size,
    mtime: stat.mtimeMs,
    auth: snapshot?.fingerprint || 'missing',
    sandbox: config.gigacodeBwrapBin || '/usr/bin/bwrap',
  })).digest('hex');
}

/**
 * Неудача metadata возвращает null, чтобы общий registry сохранил прежний выбор.
 * Ответ старого credential snapshot отбрасывается после смены аккаунта во время discovery.
 */
export async function gigaCodeCatalog(config: GigaCodeConfig) {
  try {
    const before = await gigaCodeCatalogCacheKey(config);
    const result = await readGigaCodeMetadata(config);

    return before === await gigaCodeCatalogCacheKey(config) ? result.models : null;
  } catch {
    return null;
  }
}
