import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { saveDraft } from './save.ts';
import { validateDraft } from './validate.ts';
import { compareDraft } from './compare.ts';

/**
 * Сохраняет снимок перед пробой и проверяет адресата после ожидания.
 * Ошибка записи не позволяет показать старый снимок как результат новой вставки.
 */
export async function saveStageWizardSnapshot(isCurrent: () => boolean): Promise<boolean> {
  const store = useRoutesStore();
  const identity = runtimeOf(store).openRequest;
  const generation = store.editGeneration;

  await saveDraft();

  return isCurrent() && identity === runtimeOf(store).openRequest
    && generation === store.editGeneration && !store.opened?.readOnly
    && !store.dirty && !store.saving && !store.conflict && !store.jsonBuffer?.dirty;
}

/**
 * Готовит обычное сравнение только для проверенного поколения черновика.
 * Публикация и согласие на смену источника остаются в штатных воротах редактора.
 */
export async function prepareStageWizardPublication(isCurrent: () => boolean): Promise<boolean> {
  const store = useRoutesStore();
  const identity = runtimeOf(store).openRequest;
  const generation = store.editGeneration;
  const current = () => isCurrent() && identity === runtimeOf(store).openRequest
    && generation === store.editGeneration;

  if (!await saveStageWizardSnapshot(current)) {
    return false;
  }

  // Старый успешный результат не должен скрыть ошибку нового запроса.
  store.validatedGeneration = null;
  await validateDraft();

  if (!current() || !store.canPublish) {
    return false;
  }

  store.compareReport = null;
  await compareDraft();

  return current() && store.compareGeneration === generation && Boolean(store.compareReport);
}
