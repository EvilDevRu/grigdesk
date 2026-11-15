import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';

import { VoiceError } from './contract.ts';

export interface ScriptResolver {
  scriptPath(name: string): Promise<string>;
  cleanup(): Promise<void>;
}

export interface ScriptResolverOptions {
  sea?: boolean;
  asset?: (name: string) => ArrayBuffer | string;
  temporaryRoot?: string;
}

const SCRIPT_NAMES = new Set(['piperSynth.py', 'sileroSynth.py']);

/**
 * Один resolver принадлежит одной команде; SEA-ресурсы получают приватный mkdtemp.
 * SourceDir передаёт main: в runtime CJS нет import.meta и зависимости от cwd.
 */
export function createScriptResolver(
  sourceDir: string,
  options: ScriptResolverOptions = {},
): ScriptResolver {
  const sea = options.sea ?? isSea();
  const asset = options.asset ?? ((name: string) => getAsset(name));
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  const files = new Map<string, Promise<string>>();

  let directory: Promise<string> | null = null;
  let closed = false;

  /**
   * Ленивое извлечение создаёт папку только для реально вызванного локального движка.
   * Параллельные запросы одного ресурса используют одну ожидаемую запись.
   */
  async function scriptPath(name: string): Promise<string> {
    if (closed || !SCRIPT_NAMES.has(name)) {
      throw new VoiceError('Ресурс Python недоступен.');
    }

    if (!sea) {
      return path.resolve(sourceDir, '..', 'python', name);
    }

    const cached = files.get(name);

    if (cached) {
      return cached;
    }

    directory ??= (async () => {
      await mkdir(temporaryRoot, { recursive: true });

      const created = await mkdtemp(path.join(temporaryRoot, 'grigdesk-voice-'));

      await chmod(created, 0o700);

      return created;
    })();

    const pending = directory.then(async (root) => {
      const target = path.join(root, name);
      const content = asset(name);
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);

      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });

      return target;
    });

    files.set(name, pending);

    return pending;
  }

  /**
   * Main вызывает cleanup после runVoice: runner к этому времени дождался close Python.
   * Ожидание pending extraction не позволяет записи воскресить удалённую папку.
   */
  async function cleanup(): Promise<void> {
    closed = true;
    await Promise.allSettled(files.values());

    const root = await directory?.catch(() => null);

    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }

  return { scriptPath, cleanup };
}
