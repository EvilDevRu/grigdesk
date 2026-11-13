import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Загружает состояние источника, каталога и возможностей редактора.
 * Смена current, источника или возможностей сбрасывает устаревшие проверки.
 */
export async function loadEditor(profile: string): Promise<void> {
  const store = useRoutesStore();
  const runtime = runtimeOf(store);
  const request = ++runtime.editorRequest;

  store.editorLoading = true;
  store.error = '';

  try {
    const info = await runtime.api.editor(profile);

    if (request !== runtime.editorRequest) {
      return;
    }

    const previous = store.editorInfo;

    if (previous && (previous.currentCatalogHash !== info.currentCatalogHash
      || previous.source.revision !== info.source.revision
      || previous.source.mode !== info.source.mode
      || previous.capabilitiesHash !== info.capabilitiesHash)) {
      store.compareReport = null;
      store.compareGeneration = null;
      store.rebasePreview = null;
      store.rebaseGeneration = null;

      if (previous.capabilitiesHash !== info.capabilitiesHash) {
        store.validatedRevision = null;
        store.validatedCapabilitiesHash = null;
        store.validationIssues = [];
      }
    }

    store.editorInfo = structuredClone(info);
  } catch (error) {
    if (request === runtime.editorRequest) {
      store.error = failureText(error, translateUi('core.loadEditorCouldNotOpenTheRouteEditor'));
    }
  } finally {
    if (request === runtime.editorRequest) {
      store.editorLoading = false;
    }
  }
}
