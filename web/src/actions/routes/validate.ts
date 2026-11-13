import { failureText } from '../../shared/apiClient.ts';
import { useRoutesStore } from '../../stores/routes.ts';
import { runtimeOf } from './routesRuntime.ts';
import { saveDraft } from './save.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);


/**
 * Проверяет сохранённую ревизию черновика перед публикацией.
 * Результат проверки не применяется после новых локальных изменений.
 */
export async function validateDraft(): Promise<void> {
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
    const report = await runtime.api.validateDraft(opened.profile, opened.draftId);

    if (identity !== runtime.openRequest || store.editGeneration !== generation
      || store.opened?.draftId !== opened.draftId || store.opened.profile !== opened.profile
      || report.draftId !== opened.draftId || report.draftRevision !== baseline.revision) {
      return;
    }

    store.validationIssues = report.issues;
    store.validatedRevision = report.draftRevision;
    store.validatedGeneration = generation;
    store.validatedCapabilitiesHash = report.capabilitiesHash;
  } catch (error) {
    if (identity === runtime.openRequest) {
      store.saveError = failureText(error, translateUi('core.validateCouldNotValidateTheDraft'));
    }
  }
}
