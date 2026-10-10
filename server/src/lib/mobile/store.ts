import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import { deviceName, MobileInputError } from './errors.ts';
import { privateRead, privateWrite, serialized } from './files.ts';
import { createRelayCredentials } from './identity.ts';

export type Device = {
  id: string;
  name: string;
  fp: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

export type Relay = {
  id: string;
  name: string;
  host: string;
  port: number;
  fp: string;
  brainToken: string;
  deviceToken: string;
  enabled: boolean;
  createdAt: number;
};

const FINGERPRINT = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[dr][a-f0-9]{8,32}$/;

/**
 * Проверяет версию и каждую запись до любой мутации списка.
 * Повреждение структуры не трактуется как отсутствие привязанных телефонов.
 */
async function collection<T>(
  file: string,
  field: string,
  valid: (item: T) => boolean,
): Promise<T[]> {
  const raw = await privateRead(file);

  if (raw === null) {
    return [];
  }

  const record = raw as Record<string, unknown>;
  const items = record?.[field];

  if (
    record?.version !== 1 ||
    !Array.isArray(items) ||
    !items.every((item) => item && valid(item))
  ) {
    throw new MobileInputError(
      'mobile_store_corrupt',
      'Настройки мобильного доступа повреждены.',
      503,
    );
  }

  return items;
}

function validDevice(item: Device) {
  return (
    ID.test(item.id) &&
    FINGERPRINT.test(item.fp) &&
    typeof item.name === 'string' &&
    Number.isSafeInteger(item.createdAt) &&
    Number.isSafeInteger(item.lastSeenAt) &&
    (item.revokedAt === null || Number.isSafeInteger(item.revokedAt))
  );
}

function validRelay(item: Relay) {
  return (
    ID.test(item.id) &&
    FINGERPRINT.test(item.fp) &&
    typeof item.name === 'string' &&
    typeof item.host === 'string' &&
    Number.isSafeInteger(item.port) &&
    item.port > 0 &&
    item.port <= 65535 &&
    TOKEN.test(item.brainToken) &&
    TOKEN.test(item.deviceToken) &&
    typeof item.enabled === 'boolean' &&
    Number.isSafeInteger(item.createdAt)
  );
}

export class DeviceStore {
  readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, 'devices.json');
  }

  list(): Promise<Device[]> {
    return collection(this.file, 'devices', validDevice);
  }

  async findByFp(fp: string): Promise<Device | null> {
    return (await this.list()).find((item) => item.fp === fp) ?? null;
  }

  /**
   * Добавляет сертификат атомарно; конкурирующий pair возвращает ту же запись.
   * Отозванный ключ нельзя снова привязать одноразовым кодом.
   */
  async add(input: { name: unknown; fp: string }): Promise<Device> {
    const name = deviceName(input.name);

    if (!FINGERPRINT.test(input.fp)) {
      throw new MobileInputError('bad_fingerprint', 'Неверный отпечаток телефона.');
    }

    return serialized(this.file, async () => {
      const devices = await this.list();
      const existing = devices.find((item) => item.fp === input.fp);

      if (existing?.revokedAt !== null && existing) {
        throw new MobileInputError('device_revoked', 'Телефон отозван в кокпите.', 403);
      }

      if (existing) {
        return existing;
      }

      const device = {
        id: `d${randomBytes(8).toString('hex')}`,
        name,
        fp: input.fp,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        revokedAt: null,
      };

      devices.push(device);
      await privateWrite(
        this.file,
        JSON.stringify({
          version: 1,
          devices,
        }),
      );

      return device;
    });
  }

  /**
   * Устойчиво меняет одну запись до разрыва её сетевых соединений.
   * Отсутствующий id не создаёт новую запись и не обращается к произвольному пути.
   */
  private update(id: string, operation: (device: Device) => boolean): Promise<Device> {
    return serialized(this.file, async () => {
      const devices = await this.list();
      const device = devices.find((item) => item.id === id);

      if (!device) {
        throw new MobileInputError('device_not_found', 'Телефон не найден.', 404);
      }

      if (operation(device)) {
        await privateWrite(
          this.file,
          JSON.stringify({
            version: 1,
            devices,
          }),
        );
      }

      return device;
    });
  }

  revoke(id: string): Promise<Device> {
    return this.update(id, (device) => {
      device.revokedAt ??= Date.now();

      return true;
    });
  }

  rename(id: string, input: unknown): Promise<Device> {
    const name = deviceName(input);

    return this.update(id, (device) => {
      device.name = name;

      return true;
    });
  }

  touch(id: string, now = Date.now()): Promise<Device> {
    return this.update(id, (device) => {
      if (now - device.lastSeenAt < 60000) {
        return false;
      }

      device.lastSeenAt = now;

      return true;
    });
  }
}

export class RelayStore {
  readonly directory: string;
  readonly file: string;

  constructor(directory: string) {
    this.directory = directory;
    this.file = path.join(directory, 'relays.json');
  }

  list(): Promise<Relay[]> {
    return collection(this.file, 'relays', validRelay);
  }

  /**
   * Добавляет проверенный адрес с новой личностью посредника.
   * Сначала читается список, чтобы повреждённый JSON не оставил новые бесхозные ключи.
   */
  async add(input: {
    name: unknown;
    host: string;
    port: number;
  }): Promise<Relay> {
    const name = deviceName(input.name);
    const host = typeof input.host === 'string' ? input.host.trim() : '';

    if (
      (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) ||
      !Number.isSafeInteger(input.port) ||
      input.port < 1 ||
      input.port > 65535
    ) {
      throw new MobileInputError(
        'bad_relay_address',
        'Укажите IP или имя посредника и порт от 1 до 65535.',
      );
    }

    return serialized(this.file, async () => {
      const relays = await this.list();
      const id = `r${randomBytes(8).toString('hex')}`;
      const credentials = await createRelayCredentials(this.directory, id);
      const relay = {
        id,
        name,
        host,
        port: input.port,
        fp: credentials.fp,
        brainToken: credentials.brainToken,
        deviceToken: credentials.deviceToken,
        enabled: true,
        createdAt: Date.now(),
      };

      relays.push(relay);
      await privateWrite(
        this.file,
        JSON.stringify({
          version: 1,
          relays,
        }),
      );

      return relay;
    });
  }

  /**
   * Убирает запись раньше её приватного каталога и только для известного id.
   * Произвольный путь из запроса не передаётся в файловые операции.
   */
  remove(id: string): Promise<void> {
    return serialized(this.file, async () => {
      const relays = await this.list();
      const known = relays.find((item) => item.id === id);

      if (!known) {
        throw new MobileInputError('relay_not_found', 'Посредник не найден.', 404);
      }

      await privateWrite(
        this.file,
        JSON.stringify({
          version: 1,
          relays: relays.filter((item) => item !== known),
        }),
      );
      await fs.rm(path.join(this.directory, 'relays', known.id), {
        recursive: true,
        force: true,
      });
    });
  }
}
