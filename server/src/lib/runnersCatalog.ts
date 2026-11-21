// Каталог установленных исполнителей (LLM-провайдеров) для API GrigDesk.
//
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const runCli = promisify(execFile);
const RUNNER_ID = /^[a-z][a-z0-9_-]*$/;

/**
 * Список установленных исполнителей, отсортированный. Каталога нет — список
 * пустой: выбор исполнителя в UI просто не предлагается, это не авария.
 */
export async function listInstalledRunners(config: {
  factoryBin?: string;
}): Promise<string[]> {
  if (!config.factoryBin || !path.isAbsolute(config.factoryBin)) {
    return [];
  }

  const response = await runCli(config.factoryBin, ['runners'], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    shell: false,
  }).catch(() => null);
  const ids = response?.stdout.trim().split('\n') ?? [];

  return ids.every((id) => RUNNER_ID.test(id)) ? [...new Set(ids)].sort() : [];
}
