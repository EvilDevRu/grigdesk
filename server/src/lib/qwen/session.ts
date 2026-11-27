import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface QwenSessionHomeInput {
  runtimeRoot: string;
  chatKey: unknown;
  cwd: string;
  fingerprint: string;
  extraDirs: string[];
  sessionId?: string | null;
}

/**
 * Память привязана к постоянной рабочей области, доступу и чату. Вложения
 * передаются байтами ACP и исключаются из workspace до расчёта привязки.
 */
export async function resolveQwenSessionHome(input: QwenSessionHomeInput): Promise<string> {
  const binding = createHash('sha256').update(JSON.stringify([
    input.chatKey, input.cwd, input.fingerprint,
    ...(input.extraDirs.length ? [input.extraDirs] : []),
  ])).digest('hex');
  const home = path.join(input.runtimeRoot, binding);

  if (!input.sessionId) {
    return home;
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) {
    throw new Error('Qwen: чужая или неверная identity сессии');
  }

  const saved = await fs.readFile(path.join(home, 'session.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw error;
  });

  if (saved !== input.sessionId) {
    throw new Error('Qwen: чужая или неверная identity сессии');
  }

  return home;
}
