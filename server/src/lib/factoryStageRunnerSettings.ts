import fs from 'node:fs/promises';
import path from 'node:path';

import { readContainedText } from '../../../shared/node/readContainedText.ts';
import {
  decodeStageRunnerIdentity,
  decodeStageRunnerSelection,
} from '../../../shared/pipeline/stageRunnerSettings.ts';
import type {
  StageRunnerIdentity,
  StageRunnerSelection,
} from '../../../shared/pipeline/stageRunnerSettings.ts';

export interface StageRunnerProjection {
  selection: StageRunnerSelection;
  failover: string[];
}

/**
 * Граф читает локальную настройку точного узла без запуска CLI и discovery моделей.
 * Повреждённая запись не становится политикой запуска: её проверяет exact API движка.
 */
export async function readStageRunnerProjection(
  controlDir: string | null,
  input: StageRunnerIdentity,
): Promise<StageRunnerProjection | null> {
  if (!controlDir) {
    return null;
  }

  try {
    const identity = decodeStageRunnerIdentity(input);
    const relative = [
      'protocol-v2', 'tasks', `t${identity.task}`, 'attempts', identity.attempt,
      'runner-settings', `${identity.node}.json`,
    ].join('/');
    const file = path.join(controlDir, relative);
    const [parent, stat] = await Promise.all([fs.lstat(path.dirname(file)), fs.lstat(file)]);

    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700
      || parent.uid !== process.getuid?.() || !stat.isFile() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600 || stat.uid !== parent.uid || stat.size > 65536) {
      return null;
    }

    const text = await readContainedText(controlDir, relative, 65536);

    if (!text || text.length > 65536) {
      return null;
    }

    const record = JSON.parse(text);
    const stored = decodeStageRunnerIdentity(record.identity);

    if (record.schema !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
      || Object.entries(identity).some(([key, value]) => stored[key as keyof StageRunnerIdentity] !== value)
      || (record.failover !== null && (!Array.isArray(record.failover)
        || record.failover.some((item: unknown) => typeof item !== 'string'
          || !/^[a-z][a-z0-9_-]{0,63}$/u.test(item))))) {
      return null;
    }

    return { selection: decodeStageRunnerSelection(record.selection), failover: record.failover ?? [] };
  } catch {
    return null;
  }
}
