import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChildProcess } from 'node:child_process';

import { recordOrEmpty } from '../../../../shared/lib/objects.ts';

import { createAcpClient, initializeAcp } from '../acp/client.ts';
import { ensurePrivateDir } from '../deepseek/env.ts';
import { resolveDeepSeekRuntimeAsync } from '../deepseek/runtimeProcess.ts';
import type { DeepSeekRuntimeConfig } from '../deepseek/runtimeProcess.ts';
import { GLM_ACP_EFFORT_CONFIG, GLM_ACP_MODEL_CONFIG } from './contract.ts';
import type { GlmAccessMode } from './contract.ts';
import { assertGlmRuntimeHome, buildGlmChildEnv } from './env.ts';
import { buildGlmLaunchFiles } from './profile.ts';

// Семейства нет: ACP-каталог его не публикует, а общее на все модели краткий список
// прочёл бы как версии одной модели.
export interface GlmCatalogEntry {
  id: string;
  name: string;
  tier: number;
  efforts: string[];
  contextRuntimeOnly: true;
}

/**
 * Значения выбора ACP с вложенными группами — плоским списком в порядке DSH.
 * Записи без строкового значения пропускаются, их потомки — нет.
 */
function choices(option: unknown): Array<{ value: string; name: string }> {
  const output: Array<{ value: string; name: string }> = [];
  /**
   * Обход вложенных групп сохраняет порядок DSH и имена пунктов.
   * Группа без значения сама в список не попадает.
   */
  const visit = (entries: unknown): void => {
    for (const entry of Array.isArray(entries) ? entries.map(recordOrEmpty) : []) {
      if (typeof entry.value === 'string') {
        output.push({ value: entry.value, name: String(entry.name || entry.value) });
      }

      visit(entry.options);
    }
  };

  visit(recordOrEmpty(option).options);

  return output;
}

function find(options: unknown, id: string): unknown {
  return (Array.isArray(options) ? options.map(recordOrEmpty) : []).find((entry) => entry.id === id);
}

/**
 * Модель маршрута zai — JSON-пара ["zai", "<модель>"]; другие маршруты GLM не показывает.
 * Неразбираемое значение опции ACP моделью GLM не считается.
 */
function zaiModel(value: string): boolean {
  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === 'zai'
      && typeof parsed[1] === 'string';
  } catch {
    return false;
  }
}

/**
 * Каталог GLM из ACP configOptions: только маршрут zai, id — JSON-пара. Уровни модели —
 * прочитанный список без «Provider default» (GLM всегда шлёт уровень); один уровень — без выбора.
 */
export function parseGlmCatalog(created: unknown, perModel: Record<string, unknown>): GlmCatalogEntry[] {
  const models = choices(find(created, GLM_ACP_MODEL_CONFIG)).filter((entry) => zaiModel(entry.value));

  return models.map((entry, index) => {
    const efforts = choices(find(perModel[entry.value], GLM_ACP_EFFORT_CONFIG))
      .map((choice) => choice.value)
      .filter(Boolean);

    return {
      id: entry.value,
      name: entry.name,
      tier: (models.length - index) * 10,
      efforts: efforts.length > 1 ? efforts : [],
      contextRuntimeOnly: true,
    };
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('close', () => resolve()));
}

/**
 * Metadata-only ACP-чтение каталога настоящим процессом GLM: свой home каталога, пустой
 * проект, без проектных MCP и без prompt. Уровни каждой модели — после её выбора в сессии.
 */
export async function readGlmCatalog({
  config,
  env,
  identity,
  accessMode,
  spawnProcess = spawn,
}: {
  config: DeepSeekRuntimeConfig & { glmRuntimeHome?: string };
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  identity: string;
  accessMode: GlmAccessMode;
  spawnProcess?: typeof spawn;
}): Promise<GlmCatalogEntry[]> {
  const embedded = { ...config, deepseekRuntimeMode: 'embedded' as const };
  const runtime = await resolveDeepSeekRuntimeAsync(embedded);
  const root = path.join(assertGlmRuntimeHome(String(config.glmRuntimeHome ?? '')), identity.slice(0, 16));
  const home = await ensurePrivateDir(path.join(root, 'catalog'));
  const project = await ensurePrivateDir(path.join(home, 'project'));
  const launchDir = path.join(root, 'catalog-launch', randomUUID());
  const settingsDocument = path.join(home, 'settings.yaml');

  await fs.mkdir(path.join(project, '.git'), { recursive: true, mode: 0o700 });
  await fs.writeFile(settingsDocument, '{}\n', { mode: 0o600 });

  try {
    const launch = await buildGlmLaunchFiles({
      launchDir,
      cwd: project,
      workspaceRoot: project,
      projectRoot: project,
      accessMode,
      model: 'glm-5.3',
      transport: 'acp',
      settingsDocument,
      hooks: {
        ssh: true,
        db: false,
        strictDb: false,
      },
    });
    const child = spawnProcess(runtime.command, [
      ...runtime.prefixArgs, '--profile', 'acp', '--patch', launch.overlayPath,
    ], {
      cwd: launchDir,
      env: buildGlmChildEnv({
        source: env,
        dshHome: home,
        mode: accessMode,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exit = waitForExit(child);
    const client = createAcpClient(child);

    try {
      await initializeAcp(client, 15_000);

      const created = recordOrEmpty(await client.request(
        'session/new', { cwd: project, mcpServers: [] }, 30_000
      ));
      const sessionId = String(created.sessionId || '');
      const perModel: Record<string, unknown> = {};

      for (const model of choices(find(created.configOptions, GLM_ACP_MODEL_CONFIG))) {
        if (zaiModel(model.value)) {
          const changed = recordOrEmpty(await client.request('session/set_config_option', {
            sessionId,
            configId: GLM_ACP_MODEL_CONFIG,
            value: model.value,
          }, 15_000));

          perModel[model.value] = changed.configOptions;
        }
      }

      await client.request('session/close', { sessionId }, 5_000).catch(() => {});

      return parseGlmCatalog(created.configOptions, perModel);
    } finally {
      client.close();

      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }

      await exit;
    }
  } finally {
    await fs.rm(launchDir, { recursive: true, force: true });
  }
}
