import { showcaseApi, showcaseErrorCode, showcaseErrorMessage } from '../../shared/showcaseApi';
import { openShowcaseProject } from './openShowcaseProject';
import type { ShowcaseStore } from './showcaseRuntime';

// Стадии, которым нечего делать, цепочку не останавливают: свежий клип и свежий
// звук — это готовый результат прошлого прохода, а не отказ.
const SKIPPED = ['nothing_to_record', 'nothing_to_synthesize'];

const POLL_MS = 500;

/**
 * Ролик целиком: запись сцен, озвучка и сборка mp4 одной командой. Человеку в
 * мастере не за чем знать про три отдельные стадии — он смотрит ролик, а не
 * управляет конвейером. Каждая стадия по-прежнему считает сама, что ей делать:
 * свежие клипы не переснимаются, а загруженный человеком звук не переозвучивается.
 */
export async function buildShowcaseFilm(
  store: ShowcaseStore,
  onStage: (stage: string) => void = () => {},
): Promise<boolean> {
  const opened = store.opened;

  if (!opened) {
    return false;
  }

  const stages: { label: string; run: () => Promise<unknown> }[] = [
    { label: 'Записываю сцены', run: () => showcaseApi.startRecording(opened.id) },
    { label: 'Озвучиваю сцены', run: () => showcaseApi.synthesize(opened.id) },
    { label: 'Собираю ролик', run: () => showcaseApi.assemble(opened.id) },
  ];

  try {
    for (const stage of stages) {
      onStage(stage.label);

      try {
        store.applyJob(await stage.run() as Parameters<ShowcaseStore['applyJob']>[0]);
      } catch (error) {
        if (!SKIPPED.includes(showcaseErrorCode(error))) {
          throw error;
        }

        continue;
      }

      await waitForIdle(store, opened.id);
    }

    store.setError('');
    await openShowcaseProject(store, opened.id);

    return true;
  } catch (error) {
    store.setError(showcaseErrorMessage(error, 'Не удалось собрать ролик.'));

    return false;
  } finally {
    onStage('');
  }
}

/**
 * Ожидание конца стадии. Задания живут на сервере и приходят событиями, поэтому
 * здесь только пауза до момента, когда по ролику не осталось активных: своего
 * опроса сервера цепочка не заводит.
 */
async function waitForIdle(store: ShowcaseStore, projectId: string): Promise<void> {
  while (store.jobsOf(projectId).some((job) => job.state === 'running' || job.state === 'queued')) {
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}
