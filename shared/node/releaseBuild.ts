import fs from 'node:fs/promises';
import path from 'node:path';

import { parseProductVersion } from '../runtime/productReleaseVersion.ts';

/**
 * CI передаёт продуктовый номер без изменения VERSION исходников.
 * В обычной сборке используется базовый VERSION, но оба пути проходят один валидатор.
 */
export async function readProductBuildVersion(root: string, env = process.env): Promise<string> {
  const version = env.GRIGDESK_RELEASE_VERSION
    ?? (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();

  if (!parseProductVersion(version)) {
    throw new Error('release_version_invalid');
  }

  return version;
}
