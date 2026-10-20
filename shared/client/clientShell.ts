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
  capabilities: ('scan' | 'save' | 'unlock' | 'windows')[];
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
 * Причина отображается без привязки к способу транспорта оболочки.
 * Старые строковые детали и новые структурированные причины читаются одинаково.
 */
export function connectionDetailText(detail: ShellState['detail']): string {
  return typeof detail === 'string' ? detail : detail?.message ?? '';
}


const CLIENT_FAILURES: Record<string, string> = {
  identityMismatch: 'Это не тот сервер.',
  invalid_pairing: 'Строка привязки повреждена. Получите новый код на машине.',
  unsupported_address: 'Этот тип адреса пока не поддерживается приложением.',
  server_upgrade_required: 'Обновите GrigDesk на машине.',
  client_upgrade_required: 'Обновите приложение GrigDesk.',
  pair_code_invalid: 'Код привязки недействителен или истёк. Получите новый код.',
  pair_locked: 'Слишком много попыток привязки. Повторите позже.',
  device_revoked: 'Доступ этого устройства отозван. Привяжите его заново.',
  locked: 'Разблокируйте приложение.',
};

/**
 * Системные ошибки сети могут содержать адрес и не предназначены для человека.
 * Код переводится по закрытому словарю; неизвестный отказ даёт проверяемую подсказку входа.
 */
export function clientFailureText(code: unknown): string {
  return typeof code === 'string' && CLIENT_FAILURES[code] ||
    'Машина недоступна. Проверьте связь и включён ли GRIGDESK_CLIENT_LISTEN на машине.';
}
