import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChildProcess } from 'node:child_process';

import { createAcpClient, initializeAcp } from '../acp/client.ts';
import { buildDeepSeekChildEnv, ensurePrivateDir } from './env.ts';
import { buildLaunchFiles, DEEPSEEK_PROFILE_REVISION } from './profile.ts';
import { DEEPSEEK_BASH_TOOL } from './contract.ts';
import {
  resolveDeepSeekRuntimeAsync,
  verifyDeepSeekRuntimeDescriptorAsync,
} from './runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from './runtimeProcess.ts';
import { combineDeepSeekCleanupFailure, spawnDeepSeekBinary } from './binaryProcess.ts';

interface SelectOption {
  value?: unknown;
  name?: unknown;
  options?: unknown;
}

interface ConfigOption {
  id?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

// Семейства нет: ACP-каталог его не публикует, а общее на все модели краткий список
// прочёл бы как версии одной модели. Политика `default` конвейера живёт в его каталоге.
export interface DeepSeekCatalogModel {
  id: string;
  name: string;
  tier: number;
  efforts: string[];
  contextRuntimeOnly: true;
  seed?: boolean;
}

export interface DeepSeekCatalogResult {
  models: DeepSeekCatalogModel[];
  efforts: string[];
  currentModel: string;
  currentEffort: string;
}

interface CatalogConfig extends DeepSeekRuntimeConfig {
  deepseekRuntimeHome: string;
  deepseekBin: string;
}

function flattenedOptions(value: unknown): Array<{ value: string; name: string }> {
  const output: Array<{ value: string; name: string }> = [];
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const candidate of entries as SelectOption[]) {
      if (!candidate || typeof candidate !== 'object') continue;
      const value = typeof candidate.value === 'string' ? candidate.value : '';
      if (value) output.push({ value, name: String(candidate.name || value) });
      visit(candidate.options);
    }
  };
  visit(value);
  return output;
}

export function parseDeepSeekConfigOptions(options: unknown): DeepSeekCatalogResult {
  const entries = Array.isArray(options) ? options as ConfigOption[] : [];
  const model = entries.find((entry) => entry?.id === 'model' || entry?.category === 'model');
  const effort = entries.find((entry) => (
    entry?.id === 'reasoning_effort' || entry?.category === 'thought_level'
  ));
  const efforts = flattenedOptions(effort?.options).map((entry) => entry.value).filter(Boolean);
  const rawModels = flattenedOptions(model?.options);

  return {
    models: rawModels.map((entry, index) => ({
      id: entry.value,
      name: entry.name,
      tier: (rawModels.length - index) * 10,
      efforts: [...efforts],
      contextRuntimeOnly: true,
    })),
    efforts,
    currentModel: String(model?.currentValue || ''),
    currentEffort: String(effort?.currentValue || ''),
  };
}

/**
 * Запись до первого чтения каталога: модель по умолчанию pinned-сборки DSH, чтобы выбор
 * не был пустым. Живой ACP-каталог заменит её целиком, `seed` отмечает происхождение.
 */
export function deepSeekSeedModels(): DeepSeekCatalogModel[] {
  return [{
    id: '["deepseek-official","deepseek-v4-flash"]',
    name: 'DeepSeek-V4-Flash',
    tier: 100,
    efforts: ['off', 'low', 'high', 'max'],
    contextRuntimeOnly: true,
    seed: true,
  }];
}

export function deepSeekAuth(env: NodeJS.ProcessEnv = process.env) {
  const available = Boolean(env.DEEPSEEK_API_KEY);
  return {
    mode: 'env',
    label: available
      ? 'ключ в окружении службы'
      : 'нужен DEEPSEEK_API_KEY в окружении службы',
    available,
  };
}

/**
 * Каталог зависит от payload runtime, host-профиля и текущего источника credentials.
 * Одинаковая upstream version двух поколений не позволяет переиспользовать старый каталог.
 */
export async function deepSeekCatalogCacheKey(
  config: DeepSeekRuntimeConfig & { deepseekRuntimeHome?: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  const key = String(env.DEEPSEEK_API_KEY || '');
  const keyFingerprint = key
    ? createHash('sha256').update(key).digest().subarray(0, 8).toString('hex')
    : 'missing';

  const runtime = await resolveDeepSeekRuntimeAsync(config);

  return [runtime.upstreamVersion, runtime.identity,
    DEEPSEEK_PROFILE_REVISION, keyFingerprint].join(':');
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('close', () => resolve()));
}

/** Metadata-only ACP probe: session/prompt здесь отсутствует и API-квоту не расходует. */
export async function readDeepSeekCatalog({
  config,
  env = process.env,
}: {
  config: CatalogConfig;
  env?: NodeJS.ProcessEnv;
}, {
  spawnProcess = spawn,
}: {
  spawnProcess?: typeof spawn;
} = {}): Promise<DeepSeekCatalogResult> {
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const catalogRoot = path.join(config.deepseekRuntimeHome, 'catalog',
    createHash('sha256').update(runtime.identity).digest('hex'));
  const dshHome = path.join(catalogRoot, 'home');
  const projectRoot = path.join(catalogRoot, 'project');
  const launchDir = path.join(catalogRoot, 'launch', randomUUID());
  await Promise.all([
    ensurePrivateDir(dshHome),
    ensurePrivateDir(projectRoot),
    ensurePrivateDir(launchDir),
  ]);
  // Синтетический project — постоянный каталог runtime: повторный probe обязан пережить
  // уже созданный `.git`, иначе каталог навсегда остаётся seed-ом.
  await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true, mode: 0o700 });
  const launch = await buildLaunchFiles({
    launchDir,
    cwd: projectRoot,
    workspaceRoot: projectRoot,
    mode: 'read-only',
    approval: 'never',
    hooks: {
      bashToolName: DEEPSEEK_BASH_TOOL,
      ssh: false,
      db: false,
      strictDb: false,
      instructions: { projectRoot },
    },
  });

  await verifyDeepSeekRuntimeDescriptorAsync(runtime);

  const args = [
    ...runtime.prefixArgs, '--profile', 'acp', '--patch', launch.overlayPath,
  ];
  const spawnOptions: SpawnOptions = {
    cwd: launchDir,
    env: buildDeepSeekChildEnv({ source: env, dshHome }),
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const owned = runtime.kind === 'binary'
    ? spawnDeepSeekBinary(runtime.command, args, spawnOptions, spawnProcess) : null;
  const child = owned?.child ?? spawnProcess(runtime.command, args, spawnOptions);
  const exit = waitForExit(child);
  const client = createAcpClient(child);
  let sessionId = '';
  let primaryFailure: unknown;

  try {
    await initializeAcp(client, 10_000);
    const created = await client.request('session/new', {
      cwd: projectRoot,
      mcpServers: [],
    }, 30_000) as { sessionId?: unknown; configOptions?: unknown } | null;
    sessionId = String(created?.sessionId || '');
    if (!sessionId) throw new Error('DeepSeek catalog probe не получил sessionId');
    const result = parseDeepSeekConfigOptions(created?.configOptions);
    await client.request('session/close', { sessionId }, 5_000);

    if (owned) {
      await owned.stop();

      return result;
    }

    client.close();
    const ended = await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!ended) child.kill('SIGTERM');
    return result;
  } catch (error) {
    primaryFailure = error;

    throw error;
  } finally {
    if (!client.closed) {
      if (sessionId) await client.request('session/close', { sessionId }, 1_000).catch(() => {});
      if (!owned) {
        client.close();
      }
    }

    if (owned) {
      try {
        await owned.stop();
      } catch (cleanup) {
        throw primaryFailure === undefined ? cleanup : combineDeepSeekCleanupFailure(primaryFailure, cleanup);
      } finally {
        client.close();
      }
    } else if (child.exitCode === null) {
      child.kill('SIGTERM');
    }

    await fs.rm(launchDir, { recursive: true, force: true });
  }
}
