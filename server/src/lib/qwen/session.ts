import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface QwenSessionHomeInput {
  runtimeRoot: string;
  chatKey: unknown;
  cwd: string;
  fingerprint: string;
  extraDirs: string[];
  attachmentRoot?: string;
  sessionId?: string | null;
}

/**
 * Память привязана к постоянной рабочей области, а изображения передаются байтами ACP.
 * Старый home с каталогом вложений допускается только по точному маркеру той же сессии.
 */
export async function resolveQwenSessionHome(input: QwenSessionHomeInput): Promise<string> {
  const homeFor = (extraDirs: string[]) => {
    const binding = createHash('sha256').update(JSON.stringify([
      input.chatKey, input.cwd, input.fingerprint,
      ...(extraDirs.length ? [extraDirs] : []),
    ])).digest('hex');

    return path.join(input.runtimeRoot, binding);
  };
  const home = homeFor(input.extraDirs);

  if (!input.sessionId) {
    return home;
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) {
    throw new Error('Qwen: чужая или неверная identity сессии');
  }

  const legacyDirs = input.attachmentRoot && input.attachmentRoot !== input.cwd
    ? [...new Set([...input.extraDirs, input.attachmentRoot])].sort() : input.extraDirs;
  const candidates = new Set([home, homeFor(legacyDirs)]);

  for (const candidate of candidates) {
    const saved = await fs.readFile(path.join(candidate, 'session.json'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '';
      }

      throw error;
    });

    if (saved === input.sessionId) {
      return candidate;
    }
  }

  throw new Error('Qwen: чужая или неверная identity сессии');
}
