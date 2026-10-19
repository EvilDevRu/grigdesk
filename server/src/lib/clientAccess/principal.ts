import type { Socket } from 'node:net';

export interface DeviceBinding {
  deviceId: string;
  fp: string;
  readonly revoked: boolean;
}

const devices = new WeakMap<Socket, DeviceBinding>();
const revokedFingerprints = new Set<string>();

/**
 * Клиентский вход связывает проверенный сертификат с конкретным сокетом.
 * Заголовки HTTP и cookie никогда не могут создать такую запись.
 */
export function bindDevice(socket: Socket, device: Omit<DeviceBinding, 'revoked'>): void {
  const { deviceId, fp } = device;

  devices.set(socket, {
    deviceId,
    fp,
    get revoked() {
      return revokedFingerprints.has(fp);
    },
  });
}

/**
 * Общий гард читает субъект только из реестра транспорта.
 * Обычное loopback-соединение без записи сохраняет прежний способ авторизации.
 */
export function deviceOf(socket: Socket): DeviceBinding | undefined {
  return devices.get(socket);
}

/**
 * Отзыв сертификата распространяется на все связанные с ним соединения.
 * Даже уже переданный HTTP-сокет обязан перестать давать доступ к API.
 */
export function markRevoked(fp: string): void {
  revokedFingerprints.add(fp);
}
