import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { compareDraft } from './compare.ts';
import { loadEditor } from './loadEditor.ts';
import { runtimeOf } from './routesRuntime.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Переводит профиль на публикацию через редактор.
 * Передача управления требует подтверждения и актуального сравнения.
 */
export async function enableEditorSource(approve: () => Promise<boolean>): Promise<void> {
  const store = useRoutesStore();
  const opened = store.opened;
  const report = store.compareReport;
  const info = store.editorInfo;

  if (!opened?.draftId || !report || !info || report.sourceMode !== 'profile-script'
    || info.source.mode !== 'profile-script') {
    return;
  }
  if (!await approve()) {
    return;
  }
  if (store.opened?.draftId !== opened.draftId || store.compareReport !== report) {
    return;
  }

  const runtime = runtimeOf(store);
  const identity = runtime.openRequest;

  try {
    await runtime.api.switchSource(opened.profile, {
      mode: 'editor',
      expectedSourceRevision: report.sourceRevision,
      expectedCatalogHash: report.currentCatalogHash,
    });

    if (identity !== runtime.openRequest || store.opened?.draftId !== opened.draftId) {
      return;
    }

    await loadEditor(opened.profile);
    await compareDraft();
  } catch (error) {
    if (identity === runtime.openRequest) {
      store.error = failureText(error, translateUi('core.sourceCouldNotSwitchTheRouteSource'));
    }
  }
}
