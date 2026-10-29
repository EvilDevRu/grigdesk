import path from 'node:path';

import type { DraftNode } from '../../../../shared/pipeline/routeDefinition.ts';
import { parseStageRoleCatalog } from '../../../../shared/pipeline/routeStageWizardContracts.ts';
import type {
  StageRoleCatalog, StageRoleAnswers,
} from '../../../../shared/pipeline/routeStageWizardContracts.ts';
import { pipelineSampleDirectory } from '../../lib/pipelineSample.ts';
import { importRuntimeModule } from '../../lib/runtimeImport.ts';
import type { RuntimeImportOptions } from '../../lib/runtimeImport.ts';

interface SampleDefinitions {
  definitions: Record<string, { route: { nodes: DraftNode[] }; prompts: Record<string, string> }>;
}

/**
 * Берёт инструкции только из доверенного образца поставки.
 * Пути пользовательских профилей и hooks в загрузку не попадают, включая SEA.
 */
export async function loadStageRoleCatalog(
  directory = pipelineSampleDirectory(), options: RuntimeImportOptions = {},
): Promise<StageRoleCatalog> {
  const sample = await importRuntimeModule<SampleDefinitions>(
    path.join(directory, 'profile/routes/definition.mjs'), options,
  );
  /**
   * Выбирает один узел и только используемые им инструкции.
   * Остальные данные каталога не выходят за серверную границу.
   */
  const source = (routeId: string, id: string) => {
    const bundle = sample.definitions[routeId];

    if (!bundle) {
      throw new Error('В образце отсутствует маршрут роли');
    }

    const original = bundle.route.nodes.find((item) => item.id === id);

    if (!original) {
      throw new Error('В образце отсутствует узел роли');
    }

    const node = structuredClone(original);
    const prompts = Object.fromEntries((node.prompt?.blocks ?? [])
      .map((block) => [block.file, bundle.prompts[block.file]]));

    return { node, prompts };
  };
  const defaults: Record<string, StageRoleAnswers> = {
    review: {
      filesystem: 'workspace-write',
      services: false,
      browser: false,
      failure: 'self-fix',
    },
    tests: {
      filesystem: 'workspace-write',
      services: false,
      browser: false,
      failure: 'ask',
    },
    browser: {
      filesystem: 'state-only',
      services: true,
      browser: true,
      failure: 'return',
    },
    human: {},
    command: {
      commandId: 'verify',
      filesystem: 'state-only',
      failure: 'return',
    },
    custom: {
      filesystem: 'state-only',
      services: false,
      browser: false,
      failure: 'ask',
    },
  };
  const sources = {
    review: source('small', 'review'),
    tests: source('feature', 'tests'),
    browser: source('feature', 'browser'),
    human: source('feature', 'gate_accept'),
    command: source('feature', 'verify'),
    custom: { node: null, prompts: {} },
  };

  return parseStageRoleCatalog({
    schema: 1,
    roles: Object.entries(sources).map(([id, template]) => ({
      id,
      ...template,
      defaults: defaults[id],
      ...(id === 'review' ? { companion: source('small', 'recheck') } : {}),
    })),
  });
}
