import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RouteDraft } from '../../../../shared/pipeline/routesEditorContracts.ts';

import { RoutesEditorStoreError } from './draftStore.ts';
import { checkDraftEngine, editorRouteCommand, RoutesEditorEngineError } from './editorEngine.ts';
import type { FactoryCommands } from '../../lib/factoryRuntime.ts';
import { RoutesStore } from './store.ts';
import { validateDraft } from './validation.ts';

const runCli = promisify(execFile);

export interface PreparedDraftCatalog {
  catalogHash: string;
  created: boolean;
  routeHashes: Record<string, string>;
}

/**
 * Готовит один снимок полного черновика. Даже при ошибке одного маршрута
 * уже созданные бандлы остаются неактивными: current здесь не меняется.
 */
export async function prepareDraftCatalog(
  store: RoutesStore,
  draft: RouteDraft,
  runtime?: FactoryCommands,
): Promise<PreparedDraftCatalog> {
  const snapshot = structuredClone(draft);
  const report = validateDraft(snapshot);
  const errors = report.issues.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    throw new RoutesEditorStoreError('routes_validation_failed',
      'Черновик содержит ошибки маршрута', { issues: errors });
  }

  await checkDraftEngine(snapshot, runtime);

  const routeHashes: Record<string, string> = {};
  for (const [routeId, bundle] of Object.entries(snapshot.routes).sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const prepared = await store.publishRoute(snapshot.profile, routeId, bundle);
    routeHashes[routeId] = prepared.routeHash;
  }
  const prepared = await store.prepareCatalog(snapshot.profile, {
    catalog: {
      schema: 2,
      profile: snapshot.profile,
      routes: routeHashes,
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: snapshot.bootstrap,
    prompts: snapshot.bootstrapPrompts,
  });

  // Читатель runtime перепроверяет именно возвращённый hash и его реальные байты.
  try {
    const helper = editorRouteCommand(runtime, [
      '--routes-dir', await store.engineDirectory(),
      '--profile', snapshot.profile,
      'catalog', '--catalog-hash', prepared.catalogHash,
    ]);

    await runCli(helper.command, helper.args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new RoutesEditorEngineError('Движок не подтвердил подготовленный каталог');
  }
  return { ...prepared, routeHashes };
}
