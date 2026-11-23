import { resolveInboxTriageTarget } from './inbox/triage.ts';
import { getExecutor } from './executors/index.ts';
import { getModelsRegistry, type CatalogModel, type ModelsRegistry } from './modelsRegistry.ts';
import type { WorkflowModelRef } from '../../../shared/pipeline/graphWorkflowContracts.ts';

export interface WorkflowModelChoice {
  provider: string;
  model: string;
  label: string;
}

export interface WorkflowModelCatalog {
  list(): Promise<WorkflowModelChoice[]>;
  resolve(value: WorkflowModelRef): Promise<WorkflowModelRef | null>;
}

type LogPort = { warn?: (details: unknown, message: string) => void };

interface CatalogPorts {
  registry?: (config: { modelsPath: string }) => Promise<ModelsRegistry>;
  executorResolver?: (provider: string) => Promise<unknown> | unknown;
  log?: LogPort;
}

/**
 * Единая пригодность исполнителя для списка, выбора и запуска графового шага.
 * Скрытая nonChat-модель не появляется в списке и не принимается новым стартом.
 */
export function createGraphModelCatalog(config: { modelsPath: string }, ports: CatalogPorts = {}): WorkflowModelCatalog {
  const registry = ports.registry ?? getModelsRegistry;
  const executorResolver = ports.executorResolver ?? getExecutor;
  const safeLog: LogPort = {
    warn: () => ports.log?.warn?.({ code: 'graph_model_failed' }, 'отказ модельного шага графа'),
  };

  const resolve = async (value: WorkflowModelRef): Promise<WorkflowModelRef | null> => {
    const target = await resolveInboxTriageTarget({
      modelRef: value, config, modelsRegistry: registry, executorResolver, log: safeLog,
    });

    if (!target.ok || !target.ref || !supportsGraphModel(target.executor)) {
      return null;
    }
    if ((target.model as CatalogModel | undefined)?.nonChat === true) {
      return null;
    }
    return target.effort ? { ...target.ref, effort: target.effort } : target.ref;
  };

  return {
    async list(): Promise<WorkflowModelChoice[]> {
      const snapshot = await registry(config);
      const executors = new Map<string, unknown>();
      const choices: WorkflowModelChoice[] = [];

      for (const [provider, models] of Object.entries(snapshot)) {
        if (!Array.isArray(models)) {
          continue;
        }
        if (!executors.has(provider)) {
          try {
            executors.set(provider, await executorResolver(provider));
          } catch {
            executors.set(provider, null);
          }
        }
        if (!supportsGraphModel(executors.get(provider))) {
          continue;
        }
        for (const model of models) {
          if (model.nonChat === true) {
            continue;
          }
          choices.push({ provider, model: model.id, label: model.name || model.id });
        }
      }
      return choices;
    },
    resolve,
  };
}

/**
 * Граф выдаёт работу только исполнителям с отдельным процессом под Go-арендой.
 * Наличие обычного model-only транспорта само по себе не даёт такого допуска.
 */
export function supportsGraphModel(value: unknown): boolean {
  const executor = value as {
    graphModelProcess?: boolean;
    runUntrusted?: unknown;
    untrustedInput?: { text?: boolean };
  } | null;

  return executor?.graphModelProcess === true && typeof executor.runUntrusted === 'function'
    && executor.untrustedInput?.text === true;
}
