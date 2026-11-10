import claude from './executors/claude.ts';
import codex from './executors/codex.ts';
import { config } from '../config.ts';
import { GLM_FACTORY_MODELS } from './glm/factoryCatalog.ts';
import { resolveDeepSeekRuntimeAsync } from './deepseek/runtimeProcess.ts';
import { readDeepSeekCatalog } from './deepseek/catalog.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runnerModelName } from './runnerModel.ts';
import { assertGlmGenerationAdmission, describeGlmGenerationAsync } from './glm/generation.ts';

export interface FactoryModelOption {
  id: string;
  label: string;
  efforts: string[];
  aliases: string[];
}

/**
 * Читает только native metadata, без реестра чатов и обращения к модели.
 * Каталог раннера ограничивает canonical id; effort принадлежит конкретной модели.
 */
export async function collectFactoryRunnerModels(
  provider: string, catalog: string, cli?: string,
): Promise<FactoryModelOption[]> {
  const ids = catalog.split('\n').filter(Boolean).map((line) => line.split('\t')[0]!);
  let models: FactoryModelOption[];

  if (provider === 'codex') {
    const entries = await codex.catalog({
      codexBin: cli || process.env.GRIGDESK_CODEX_BIN || config.codexBin,
    });

    models = (entries || []).flatMap((entry) => {
      const id = String(entry.id);
      const efforts = entry.efforts;

      return ids.includes(id) && Array.isArray(efforts) && efforts.length ? [{
        id,
        label: String(entry.name || id),
        efforts: efforts.map(String),
        aliases: [],
      }] : [];
    });
  } else if (provider === 'claude') {
    const selected = { ...config, claudeBin: cli || process.env.GRIGDESK_CLAUDE_BIN || config.claudeBin };
    const [entries, ladder] = await Promise.all([claude.catalog(selected), claude.efforts(selected)]);

    models = (entries || []).flatMap((entry) => {
      const model = entry as Record<string, unknown>;
      const levels = claude.modelEfforts(model, ladder, ladder);

      if (!Array.isArray(levels) || model.effortUnverified) {
        return [];
      }

      return [{
        id: String(model.id),
        label: String(model.name || model.id),
        efforts: levels.length ? [...levels] : [''],
        aliases: Array.isArray(model.aliases) ? model.aliases.map(String) : [],
      }];
    });
  } else if (provider === 'kimi') {
    models = ids.map((id) => ({
      id,
      label: id,
      efforts: ['low', 'high', 'max'],
      aliases: [],
    }));
  } else if (provider === 'glm') {
    const runtimeConfig = { ...config, deepseekRuntimeMode: 'binary' as const };
    const runtime = await resolveDeepSeekRuntimeAsync(runtimeConfig);
    const generation = await describeGlmGenerationAsync(runtimeConfig, runtime);
    const mode = process.env.GRIGDESK_GLM_API_MODE;

    if (mode !== 'api' && mode !== 'coding-plan') {
      throw new Error('glm: неподтверждённый режим доступа');
    }

    assertGlmGenerationAdmission(generation, mode);
    models = GLM_FACTORY_MODELS.filter((model) => ids.includes(model.id)).map((model) => ({
      id: model.id,
      label: runnerModelName(model.id) || model.id,
      efforts: [...model.efforts],
      aliases: [],
    }));
  } else if (provider === 'deepseek') {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-models-'));

    try {
      const metadata = await readDeepSeekCatalog({ config: { ...config, deepseekRuntimeHome: temporary } });

      models = metadata.models.filter((model) => ids.includes(model.id)).map((model) => ({
        id: model.id,
        label: model.name,
        efforts: model.efforts.filter((effort) => ['off', 'low', 'high', 'max'].includes(effort)),
        aliases: [],
      }));
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  } else {
    throw new Error('metadata_unavailable: неизвестный исполнитель');
  }

  if (!models.length) {
    throw new Error('metadata_unavailable: каталог моделей недоступен');
  }

  return models;
}
