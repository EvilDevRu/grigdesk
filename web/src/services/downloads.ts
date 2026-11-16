import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);


export interface UiDownloadAdapter {
  available(): boolean;
  save(href: string, name?: string): Promise<void>;
}

let adapter: UiDownloadAdapter | null = null;

/**
 * Product подключает нативное сохранение через публичный UI-порт.
 * Сам набор controls не знает о Pinia или API оболочки.
 */
export function setUiDownloadAdapter(value: UiDownloadAdapter | null): void {
  adapter = value;
}

/**
 * Проверка выполняется синхронно до браузерного default action ссылки.
 * Без установленного адаптера ссылка сохраняет обычное поведение.
 */
export function uiDownloadAvailable(): boolean {
  return adapter?.available() === true;
}

/**
 * Ссылка передаёт только адрес и имя файла зарегистрированному адаптеру.
 * Ошибку сохранения показывает общий UI без содержимого файла.
 */
export function saveUiDownload(href: string, name?: string): Promise<void> {
  return adapter?.save(href, name) || Promise.reject(new Error(t('core.coreSohranenieNedostupno')));
}
