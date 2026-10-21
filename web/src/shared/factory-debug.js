import { localeTranslator, messageLabels } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import { DIAGNOSTIC_LEVELS } from '../../../shared/web-log/diagnosticLogging.ts';

const MESSAGES = {
  off: 'settings.diagnosticOff',
  errors: 'settings.diagnosticErrors',
  decisions: 'settings.diagnosticDecisions',
  verbose: 'settings.diagnosticVerbose',
};

const LABELS = messageLabels(MESSAGES, uiLocalePort);

export const FACTORY_DEBUG_LEVELS = Object.freeze(DIAGNOSTIC_LEVELS.map((value) => ({
  value,
  get label() {
    return LABELS[value];
  },
})));

const VALUES = new Set(FACTORY_DEBUG_LEVELS.map((item) => item.value));

/**
 * Тело запроса сохраняет технический уровень и общую область диагностики.
 * Только собственный отказ при неизвестном уровне зависит от языка установки.
 */
export function factoryDebugPayload(level) {
  if (!VALUES.has(level)) {
    throw new Error(localeTranslator(uiLocalePort)('settings.diagnosticUnknownLevel'));
  }

  return { scope: 'global', level };
}
