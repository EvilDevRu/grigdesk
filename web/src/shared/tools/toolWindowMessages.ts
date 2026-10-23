import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../uiLocalePort.ts';

/**
 * Сообщения передачи используют тот же язык, что и публичная граница интерфейса.
 * Чистый адаптер не загружает компоненты панелей в координатор или native transport.
 */
export function toolWindowText(key: string): string {
  return localeTranslator(uiLocalePort)('core.' + key);
}
