import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { saveDraft } from './save.ts';

/**
 * Получает разницу черновика с текущим опубликованным каталогом.
 * Сравнение относится к сохранённой ревизии, а не к незаписанному вводу.
 */
export async function compareDraft(): Promise<void> {
  const store = useRoutesStore();

  if (store.dirty) {
    await saveDraft();
  }

  const opened = store.opened;
  const baseline = store.serverSnapshot;

  if (!opened?.draftId || !baseline || store.dirty || store.conflict) {
    return;
  }

  const runtime = runtimeOf(store);
  const identity = runtime.openRequest;
  const generation = store.editGeneration;

  try {
    const report = await runtime.api.compareDraft(opened.profile, opened.draftId);

    if (identity !== runtime.openRequest || generation !== store.editGeneration
      || store.opened?.draftId !== opened.draftId || store.opened.profile !== opened.profile
      || report.draftId !== opened.draftId || report.draftRevision !== baseline.revision) {
      return;
    }

    store.compareReport = structuredClone(report);
    store.compareGeneration = generation;
  } catch (error) {
    if (identity === runtime.openRequest) {
      store.error = failureText(error, 'Не удалось сравнить черновик с каталогом.');
    }
  }
}
