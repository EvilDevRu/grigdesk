
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

// Читаемые названия исходов не меняют технические значения в документе маршрута.
export const outcomeNames: Record<string, string> = {
  get done() {
    return translateUi('core.routeLabelsCompleted');
  },
  get skipped() {
    return translateUi('core.corePropuscheno');
  },
  get failed() {
    return translateUi('core.error');
  },
  get exhausted() {
    return translateUi('core.routeLabelsRetriesExhausted');
  },
  get approved() {
    return translateUi('core.routeLabelsApproved');
  },
  get rejected() {
    return translateUi('core.routeLabelsRejected');
  },
  get noResult() {
    return translateUi('core.routeLabelsNoResult');
  },
};
