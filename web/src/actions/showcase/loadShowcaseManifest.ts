import { showcaseApi } from '../../shared/showcaseApi';
import { runtimeOf } from './showcaseRuntime';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Загружает проверенную шкалу текущего v1 final. Ошибка производного JSON не
 * закрывает сам ролик: store отмечает manifest как failed, а точная навигация
 * остаётся выключенной без подстановки расчёта от исходных клипов.
 */
export function loadShowcaseManifest(store: ShowcaseStore): Promise<boolean> {
  const project = store.opened;
  const final = project?.latestFinal;

  if (!project || final?.manifestVersion !== 1) {
    return Promise.resolve(false);
  }

  if (store.currentManifest) {
    return Promise.resolve(true);
  }

  const key = `${project.id}:${final.manifestId}`;
  const runtime = runtimeOf(store);
  const pending = runtime.manifests.get(key);

  if (pending) {
    return pending;
  }

  const projectId = project.id;
  const manifestId = final.manifestId;
  const videoId = final.video.id;

  store.beginManifestLoad(projectId, manifestId);

  const request = showcaseApi.finalManifest(projectId, manifestId)
    .then((manifest) => {
      if (manifest.projectId !== projectId || manifest.video.id !== videoId) {
        throw new Error('Manifest относится к другому ролику или видео.');
      }

      store.setManifest(projectId, manifestId, manifest);

      return true;
    })
    .catch(() => {
      store.failManifestLoad(projectId, manifestId);

      return false;
    })
    .finally(() => {
      runtime.manifests.delete(key);
    });

  runtime.manifests.set(key, request);

  return request;
}
