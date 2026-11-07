import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GigaCodeConfig } from './contract.ts';

interface NativeCredential {
  token: string;
  expiryDate: number;
  config?: unknown;
}

export interface GigaCodeCredentialSnapshot {
  credential: NativeCredential;
  fingerprint: string;
}

const MAX_CREDENTIAL_BYTES = 1024 * 1024;

/**
 * Читается только документированный native cache, без истории и общего settings.json.
 * Удерживаемый fd, no-follow и лимит не дают подменить источник между проверкой и чтением.
 */
export async function readGigaCodeCredentialSnapshot(
  config: GigaCodeConfig,
  now = Date.now(),
): Promise<GigaCodeCredentialSnapshot | null> {
  const home = config.gigacodeHome || path.join(os.homedir(), '.gigacode');
  const file = path.join(home, 'gigacode_token.json');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);

  if (!handle) {
    return null;
  }

  try {
    const info = await handle.stat();

    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_CREDENTIAL_BYTES) {
      return null;
    }

    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead !== info.size || bytesRead > MAX_CREDENTIAL_BYTES) {
      return null;
    }

    const raw = buffer.subarray(0, bytesRead);
    const parsed: unknown = JSON.parse(raw.toString('utf8'));

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const value = parsed as Partial<NativeCredential>;

    if (typeof value.token !== 'string' || !value.token || value.token.length > 65536
      || typeof value.expiryDate !== 'number' || !Number.isFinite(value.expiryDate)
      || value.expiryDate <= now + 60000) {
      return null;
    }

    return {
      credential: {
        token: value.token,
        expiryDate: value.expiryDate,
        ...(value.config === undefined ? {} : { config: value.config }),
      },
      fingerprint: createHash('sha256').update(path.resolve(home)).update(raw).digest('hex'),
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Карточка получает только наличие локального OAuth cache и проверку срока.
 * Токен, native config и внутренний fingerprint в API-проекцию не попадают.
 */
export async function gigaCodeAuth(config: GigaCodeConfig) {
  const snapshot = await readGigaCodeCredentialSnapshot(config);

  return {
    mode: 'cli-oauth',
    available: snapshot !== null,
    label: snapshot
      ? 'Локальный OAuth-токен CLI, срок проверен'
      : 'Нужен вход через GigaCode CLI; API-ключ не используется',
  };
}
