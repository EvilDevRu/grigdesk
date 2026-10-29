import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizeServiceHost } from '../../../shared/plugins/sandboxes/serviceHost.ts';
import { PROFILE_RE } from './profiles.ts';

/**
 * Читать только буквальное присваивание хоста из доверенного каталога профилей.
 * Shell-код не исполняется; отсутствующий или динамический адрес остаётся неизвестным.
 */
export async function readProfileServiceHost(profilesDir: string, profile: string): Promise<string | null> {
  if (!PROFILE_RE.test(profile)) {
    return null;
  }

  try {
    const raw = await fs.readFile(path.join(profilesDir, profile, 'profile.sh'), 'utf8');
    const match = /^PROFILE_SERVICE_HOST=(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/m.exec(raw);

    return normalizeServiceHost(match?.[1] ?? match?.[2] ?? match?.[3]);
  } catch {
    return null;
  }
}
