import type { BrowserPreferences } from '../browser/browserContract.ts';

import { translator } from '../i18n/catalogs.ts';

import type { WindowControlsState } from '../desktop/windowControls.ts';

export type ConnectionStatus = 'none' | 'connecting' | 'online' | 'offline' | 'locked'
  | 'unpaired' | 'revoked' | 'identityMismatch' | 'incompatible';

export interface ApiVersion {
  major: number;
  minor: number;
}

export interface MachineProfile {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  address: string;
  status: ConnectionStatus;
}

export interface ShellState {
  browser?: { preferences: BrowserPreferences; revision: number };
  windowControls?: WindowControlsState;
  desktopExit?: { skipConfirmation: boolean };
  locale?: { preference: string; systemLanguage: string };
  rev: number;
  status: ConnectionStatus;
  detail: string | {
    code?: string;
    message?: string;
    retryAt?: number;
  } | null;
  profile: MachineProfile | null;
  profiles: MachineProfile[];
  localAvailable: boolean;
  serverApi: ApiVersion | null;
  appApi: ApiVersion;
  capabilities: ('scan' | 'save' | 'unlock' | 'windows' | 'taskSources' | 'browser'
    | 'applicationLauncher')[];
}

export const RELEASES_URL = '';

export const CONNECTION_TEXT: Record<ConnectionStatus, string> = {
  none: 'Машина не выбрана',
  connecting: 'Подключение…',
  online: 'в сети',
  offline: 'нет связи',
  locked: 'нужно разблокировать',
  unpaired: 'нужна привязка',
  revoked: 'устройство отозвано',
  identityMismatch: 'сертификат машины изменился',
  incompatible: 'нужно обновление',
};

/**
 * Коды состояния переводятся отдельно от сохранённых имён и серверных причин.
 * Прежние вызовы без локали сохраняют точные русские подписи протокола UI.
 */
export function connectionStatusText(status: ConnectionStatus, locale = 'ru'): string {
  return translator.t(locale, `core.connection.${status}`, {}, CONNECTION_TEXT[status]);
}

/**
 * Заводское имя локального профиля принадлежит приложению, а удалённые имена — человеку.
 * Проекция не переписывает настройки профиля и не меняет его идентификатор.
 */
export function machineProfileName(profile: MachineProfile, locale = 'ru'): string {
  return profile.kind === 'local' && profile.name === 'Этот компьютер'
    ? translator.t(locale, 'core.thisComputer') : profile.name;
}

/**
 * Причина отображается без привязки к способу транспорта оболочки.
 * Старые строковые детали и новые структурированные причины читаются одинаково.
 */
export function connectionDetailText(detail: ShellState['detail'], locale = 'ru'): string {
  if (typeof detail === 'string') {
    return detail;
  }

  const code = detail?.code;

  return code && Object.hasOwn(CLIENT_FAILURES, code)
    ? translator.t(locale, `native.${code}`) : detail?.message ?? '';
}


const CLIENT_FAILURES: Record<string, string> = {
  offline: 'Сервер недоступен. Проверьте связь и доступ к серверу.',
  unpaired: 'Нужна повторная привязка устройства.',
  device_unknown: 'Устройство не найдено. Получите новый QR и привяжите его заново.',
  device_scope_forbidden: 'Отзовите старую привязку и подключите актуальное приложение новым QR.',
  relay_upgrade_required: 'Обновите ретранслятор сервера для нового приложения.',
  relay_pin_mismatch: 'Сертификат ретранслятора не совпал. Дома телефон подключится напрямую.',
  relay_unauthorized: 'Ретранслятор отклонил ключ телефона. Получите новый QR.',
  identityMismatch: 'Это не тот сервер.',
  invalid_pairing: 'Строка привязки повреждена. Получите новый код на машине.',
  unsupported_address: 'Этот тип адреса пока не поддерживается приложением.',
  server_upgrade_required: 'Обновите GrigDesk на машине.',
  client_upgrade_required: 'Обновите приложение GrigDesk.',
  pair_code_invalid: 'Код привязки недействителен или истёк. Получите новый код.',
  pair_locked: 'Слишком много попыток привязки. Повторите позже.',
  device_revoked: 'Доступ этого устройства отозван. Привяжите его заново.',
  locked: 'Разблокируйте приложение.',
  disconnected: 'Отключено',
  retry_wait: 'Ожидание повторного подключения',
  identity_unavailable: 'Нужна повторная привязка устройства.',
};

/**
 * Системные ошибки сети могут содержать адрес и не предназначены для человека.
 * Код переводится по закрытому словарю; неизвестный отказ даёт проверяемую подсказку входа.
 */
export function clientFailureText(code: unknown, locale = 'ru'): string {
  const key = typeof code === 'string' && Object.hasOwn(CLIENT_FAILURES, code) ? code : 'offline';

  return translator.t(locale, `native.${key}`);
}
