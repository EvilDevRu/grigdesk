// Подготовка демо-данных профильным рецептом.
//
// Рецепт объявляет профиль стенда, а не раздел: что считать «показательными
// данными», знает владелец продукта. Раздел только показывает, что именно будет
// запущено, и запускает это после подтверждения человека.
import path from 'node:path';

import { ShowcaseError } from './errors.ts';
import { createSeedDecision, runSeed, seedAvailability } from './seed.ts';
import type { SeedDecision } from './seed.ts';
import type { ShowcaseProject } from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseStore } from './store.ts';
import type { ShowcaseTargets } from './targets.ts';

export interface SeedOpsDeps {
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  // Подготовка данных не идёт поверх работающего задания: журнал нужен, чтобы
  // отказать до запуска рецепта, а не посреди записи.
  jobs: { list: (projectId: string) => { state: string }[] };
  // Удачный рецепт двигает ревизию данных сам: она входит в отпечаток цели, и
  // после подготовки записи по прежним данным считаются устаревшими.
  setDataRevision: (ref: ShowcaseProject['ref'], revision: string) => void;
  readProject: (id: string) => Promise<ShowcaseProject>;
  store: ShowcaseStore;
  targets: ShowcaseTargets;
}

export function createSeedOps(deps: SeedOpsDeps) {
  const {
    assertEnabled, broadcast, jobs, readProject, setDataRevision, store, targets,
  } = deps;

  /**
   * Доступна ли подготовка данных для этой цели и что именно будет запущено.
   * Отдаётся до подтверждения: человек соглашается на конкретный рецепт на
   * конкретном стенде, а не на «подготовку данных вообще».
   */
  async function seedStatus(id: string): Promise<{
    available: boolean;
    reason: string;
    recipeFingerprint: string;
    profile: string;
    targetLabel: string;
  }> {
    assertEnabled();

    const project = await readProject(id);

    if (project.target.status !== 'ready') {
      return {
        available: false,
        reason: project.target.reason,
        recipeFingerprint: '',
        profile: '',
        targetLabel: '',
      };
    }

    const scope = await targets.internalScope(project.ref, project.target.scope.profile);
    const availability = await seedAvailability(scope, targets.contractDir(scope.profile));

    return {
      available: availability.available,
      reason: availability.reason,
      recipeFingerprint: availability.recipeFingerprint,
      profile: scope.profile,
      targetLabel: scope.targetLabel,
    };
  }

  /**
   * Запуск подготовки данных. Одна блокировка цели: пока идёт запись или сборка,
   * seed не стартует и наоборот — менять данные под работающим браузером значит
   * получить ролик, снятый наполовину до, наполовину после.
   *
   * После успеха все кадры и клипы устаревают: показывать свежие данные старой
   * записью нельзя.
   */
  async function prepareData(id: string, recipeFingerprint: string): Promise<{
    state: string;
    reason: string;
  }> {
    assertEnabled();

    const project = await readProject(id);

    if (jobs.list(id).some((job) => job.state === 'running' || job.state === 'queued')) {
      throw new ShowcaseError(
        'target_busy',
        'По ролику уже идёт работа: подготовка данных и запись не запускаются одновременно.',
        409,
      );
    }

    if (project.target.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', project.target.reason, 409);
    }

    const scope = await targets.internalScope(project.ref, project.target.scope.profile);
    const availability = await seedAvailability(scope, targets.contractDir(scope.profile));
    const decision: SeedDecision = createSeedDecision(recipeFingerprint);
    const outcome = await runSeed({
      scope,
      availability,
      decision,
      workDir: path.join(store.jobsDir, `seed-${id}`),
    });

    if (outcome.state === 'succeeded' && outcome.dataRevision) {
      setDataRevision(project.ref, outcome.dataRevision);
      broadcast('showcase-changed', { projectId: id, revision: project.revision });
    }

    return { state: outcome.state, reason: outcome.reason };
  }

  return { prepareData, seedStatus };
}
