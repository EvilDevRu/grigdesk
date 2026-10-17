import type {
  RouteTransferBundle, RouteTransferImportResult,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { loadDraft } from './loadDraft.ts';
import { runtimeOf } from './routesRuntime.ts';

/** Экспортирует только сохранённую ревизию открытого черновика. */
/**
 * Выгружает маршрут или каталог в версионированный формат.
 * Импорт проверяет привязки и ограничения до изменения черновика.
 */
export async function exportRouteTransfer(routeId: string | null): Promise<RouteTransferBundle> {
  const store = useRoutesStore();
  const opened = store.opened;

  if (!opened?.draftId || !store.serverSnapshot || store.dirty || store.saving
    || store.conflict || store.jsonBuffer?.dirty) {
    throw new Error('Сначала сохраните черновик и разрешите конфликт записи.');
  }

  return runtimeOf(store).api.exportDraftTransfer(opened.profile, opened.draftId, routeId);
}

/** Импортирует переносимый JSON как отдельный черновик выбранного профиля. */
/**
 * Создаёт черновик из проверенного импортируемого каталога.
 * Импорт проверяет привязки и ограничения до изменения черновика.
 */
export async function importRouteTransfer(title: string, targetProfile: string,
  bundle: RouteTransferBundle): Promise<RouteTransferImportResult> {
  const store = useRoutesStore();

  return runtimeOf(store).api.importDraftTransfer(targetProfile, title, bundle);
}

/** Добавляет один маршрут одной ревизией в уже открытый черновик. */
/**
 * Добавляет импортированный маршрут в открытый черновик.
 * Импорт проверяет привязки и ограничения до изменения черновика.
 */
export async function addRouteTransfer(bundle: RouteTransferBundle,
  collision: 'require-choice' | 'cancel' | 'replace' | 'rename',
  newRouteId?: string): Promise<RouteTransferImportResult> {
  const store = useRoutesStore();
  const opened = store.opened;
  const snapshot = store.serverSnapshot;

  if (!opened?.draftId || !snapshot || opened.readOnly || store.dirty || store.saving
    || store.conflict || store.jsonBuffer?.dirty) {
    throw new Error('Сначала сохраните редактируемый черновик.');
  }

  const result = await runtimeOf(store).api.addRouteTransfer(opened.profile, opened.draftId, {
    expectedRevision: snapshot.revision,
    bundle,
    collision,
    ...(newRouteId ? { newRouteId } : {}),
  });

  if (!result.cancelled) {
    await loadDraft(opened.profile, opened.draftId);
  }

  return result;
}
