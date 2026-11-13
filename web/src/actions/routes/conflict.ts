import { useRoutesStore } from '../../stores/routes.ts';
import { createDraft } from './createDraft.ts';
import { loadDraft } from './loadDraft.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);


/** Копия получает собственный UUID; прежний черновик остаётся на сервере нетронутым. */
/**
 * Создаёт отдельный черновик из локальной версии при конфликте.
 * Несохранённый локальный текст остаётся доступным при конфликте ревизий.
 */
export async function saveConflictCopy(): Promise<void> {
  const store = useRoutesStore();
  const local = store.localDocument;
  const opened = store.opened;

  if (!local || !opened?.draftId || opened.readOnly) {
    return;
  }
  if (store.jsonBuffer?.dirty) {
    store.saveError = t('core.routeSnachalaPrimeniteIliSkopiruyte');

    return;
  }

  await createDraft(opened.profile, {
    kind: 'document',
    title: t('core.routeTitleKopiya', { title: local.title }),
    baseCatalogHash: local.baseCatalogHash,
    baseSourceRevision: local.baseSourceRevision,
    document: {
      routes: JSON.parse(JSON.stringify(local.routes)),
      bootstrap: JSON.parse(JSON.stringify(local.bootstrap)),
      bootstrapPrompts: JSON.parse(JSON.stringify(local.bootstrapPrompts)),
      presentation: JSON.parse(JSON.stringify(local.presentation)),
      provenance: JSON.parse(JSON.stringify(local.provenance)),
    },
  });
}

/**
 * Загружает серверный снимок после явного подтверждения потери локальной версии.
 * Несохранённый локальный текст остаётся доступным при конфликте ревизий.
 */
export async function reloadConflict(approve: () => Promise<boolean>): Promise<void> {
  const store = useRoutesStore();
  const opened = store.opened;

  if (!opened?.draftId || !await approve()) {
    return;
  }
  if (store.opened?.draftId !== opened.draftId || store.opened.profile !== opened.profile) {
    return;
  }

  await loadDraft(opened.profile, opened.draftId);
}
