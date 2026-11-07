import { promises as fs } from 'node:fs';
import path from 'node:path';

import { MobileInputError } from './errors.ts';
import { ensureBrainIdentity, renderRelayEnv } from './identity.ts';
import { startMobileServer } from './mobileServer.ts';
import type { MobileApp } from './mobileServer.ts';
import { PairingCodes } from './pairing.ts';
import { RelayHub } from './relayHub.ts';
import { DeviceStore, RelayStore } from './store.ts';
import type { Relay } from './store.ts';

type MobileServer = {
  port: number;
  close: () => Promise<void>;
  disconnectDevice: (fp: string) => void;
};

type Hub = Pick<RelayHub, 'sync' | 'close' | 'status'>;

type Options = {
  directory: string;
  port: number;
  vpnGate: (ip: string) => Promise<boolean>;
  name?: string;
  version?: string;
  changed?: () => void;
  disconnectClient?: (fp: string) => void;
  log?: (event: string) => void;
  registerRoutes?: (app: MobileApp) => void | Promise<void>;
  recoverOperation?: Parameters<typeof startMobileServer>[0]['recoverOperation'];
  makeHub?: (options: ConstructorParameters<typeof RelayHub>[0]) => Hub;
  makeServer?: (options: Parameters<typeof startMobileServer>[0]) => Promise<MobileServer>;
};

/**
 * Владеет только мобильным входом и исходящими соединениями с посредниками.
 * Ошибка private store, ключа или порта не прерывает основной сервер GrigDesk.
 */
export class MobileService {
  readonly devices: DeviceStore;
  readonly relays: RelayStore;
  readonly pairing: PairingCodes;
  private options: Options;
  private server: MobileServer | null = null;
  private hub: Hub | null = null;
  private identity: Awaited<ReturnType<typeof ensureBrainIdentity>> | null = null;
  private error: string | null = null;
  private clientTarget?: () => Promise<number>;

  setClientTarget(target: () => Promise<number>): void {
    this.clientTarget = target;
  }

  constructor(options: Options) {
    this.options = options;
    this.devices = new DeviceStore(options.directory);
    this.relays = new RelayStore(options.directory);
    this.pairing = new PairingCodes({ devices: this.devices });
  }

  /**
   * Поднимается после listen основного API, когда inject уже доступен адаптерам.
   * До открытия TLS проверяет оба списка и согласованность пары ключ/сертификат.
   */
  async start() {
    if (this.server || this.hub) {
      return;
    }

    try {
      const relays = await this.relays.list();

      await this.devices.list();
      this.identity = await ensureBrainIdentity(this.options.directory);

      this.error = null;

      try {
        this.server = await (this.options.makeServer ?? startMobileServer)({
        identity: this.identity,
        directory: this.options.directory,
        deviceStore: this.devices,
        pairing: this.pairing,
        port: this.options.port,
        serverName: this.options.name,
        version: this.options.version,
        registerRoutes: this.options.registerRoutes,
        recoverOperation: this.options.recoverOperation,
        log: this.options.log,
      });
      } catch (failure) {
        if (!this.clientTarget) {
          throw failure;
        }

        this.error = 'Прежний мобильный вход недоступен. Проверьте его порт и настройки.';
        this.options.log?.('mobile_v1_start_failed');
      }

      this.hub = (this.options.makeHub ?? ((options) => new RelayHub(options)))({
        mobilePort: this.server?.port ?? 0,
        clientTarget: this.clientTarget,
        vpnGate: this.options.vpnGate,
        changed: this.options.changed,
      });
      this.hub.sync(relays);
    } catch {
      await this.close();
      this.error = 'Мобильный доступ не запущен. Проверьте настройки и порт.';
      this.options.log?.('mobile_start_failed');
    }

    this.options.changed?.();
  }

  /**
   * Возвращает административный снимок без токенов и PEM-ключей.
   * При повреждённом store статус остаётся читаемым, а мутации закрываются с 503.
   */
  async status() {
    try {
      return {
        server: {
          up: !!this.server,
          port: this.server?.port ?? this.options.port,
          error: this.error,
        },
        relays: (await this.relays.list()).map((relay) => ({
              ...publicRelay(relay),
              enabled: relay.enabled,
              link: this.hub?.status().find((link) => link.id === relay.id) ?? {
                compatibility: 'unknown' as const,
                state: 'offline',
                since: Date.now(),
                lastError: null,
                pipes: 0,
              },
            })),
        devices: this.server ? await this.devices.list() : [],
      };
    } catch {
      await this.close();
      this.error = 'Настройки мобильного доступа повреждены.';

      return {
        server: {
          up: false,
          port: this.options.port,
          error: this.error,
        },
        relays: [],
        devices: [],
      };
    }
  }

  requireReady() {
    if (!this.hub || !this.identity) {
      throw new MobileInputError(
        'mobile_unavailable',
        this.error ?? 'Мобильный доступ ещё не запущен.',
        503,
      );
    }
  }

  /**
   * Публикует новую конфигурацию после durable записи списка.
   * Хаб не подключается, если отдельный TLS-вход недоступен.
   */
  async addRelay(input: Parameters<RelayStore['add']>[0]) {
    this.requireReady();

    const relay = await this.relays.add(input);

    this.hub!.sync(await this.relays.list());
    this.options.changed?.();

    return publicRelay(relay);
  }

  /**
   * Закрывает пары удалённого посредника после изменения durable настроек.
   * Остальные соединения и ключ мозга сохраняются.
   */
  async removeRelay(id: string) {
    this.requireReady();
    await this.relays.remove(id);
    this.hub!.sync(await this.relays.list());
    this.options.changed?.();
  }

  /**
   * Отзыв сперва фиксируется на диске, затем отключает все сокеты сертификата.
   * Сохранённые результаты команд также остаются за проверкой отзыва.
   */
  async revokeDevice(id: string) {
    this.requireReady();

    const device = await this.devices.revoke(id);

    this.server?.disconnectDevice(device.fp);
    this.options.disconnectClient?.(device.fp);
    this.options.changed?.();
  }

  /**
   * Общий API устройств отзывает durable запись независимо от готовности мобильного входа.
   * Этот адаптер закрывает только существующие v1-сокеты и не требует requireReady.
   */
  disconnectDevice(fp: string): void {
    this.server?.disconnectDevice(fp);
  }

  /**
   * Читает секреты только для известной проверенной записи посредника.
   * Входной id не используется как произвольный путь к файлу.
   */
  async relay(id: string) {
    this.requireReady();

    const relay = (await this.relays.list()).find((item) => item.id === id);

    if (!relay) {
      throw new MobileInputError('relay_not_found', 'Посредник не найден.', 404);
    }

    return relay;
  }

  /**
   * Собирает env с хэшами токенов вместо самих токенов.
   * TLS-ключ передаётся лишь явным защищённым скачиванием без кэша.
   */
  async relayEnv(id: string) {
    const relay = await this.relay(id);
    const directory = path.join(this.options.directory, 'relays', relay.id);
    const keyPem = await fs.readFile(path.join(directory, 'relay-key.pem'), 'utf8');
    const certPem = await fs.readFile(path.join(directory, 'relay-cert.pem'), 'utf8');

    return renderRelayEnv({
      keyPem,
      certPem,
      brainToken: relay.brainToken,
      deviceToken: relay.deviceToken,
    });
  }

  /**
   * QR несёт пины обоих TLS-слоёв и только телефонный токен посредника.
   * Одноразовый код выдаётся лишь для явной операции привязки.
   */
  async qr(id: string, pair: boolean) {
    const relay = await this.relay(id);
    const issued = pair ? this.pairing.issue() : null;
    const payload = {
      v: 1,
      brain: {
        name: this.options.name ?? 'GrigDesk',
        fp: this.identity!.fp,
      },
      relay: {
        ...publicRelay(relay),
        token: relay.deviceToken,
      },
      ...(issued ? { pair: issued } : {}),
    };
    const text = `grigdesklink:1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

    if (Buffer.byteLength(text) > 4096) {
      throw new MobileInputError('qr_too_large', 'Данные посредника не помещаются в QR.');
    }

    return {
      text,
      expiresAt: issued?.exp ?? null,
    };
  }

  /**
   * Закрывает свои соединения и TLS-вход при общем shutdown или ошибке старта.
   * Повторное закрытие не затрагивает чужие процессы.
   */
  async close() {
    this.hub?.close();
    this.hub = null;

    const server = this.server;

    this.server = null;
    await server?.close();
  }
}

/**
 * Общий безопасный вид посредника для настроек и QR.
 * Секретные токены никогда не попадают в административный список.
 */
function publicRelay(relay: Relay) {
  return {
    id: relay.id,
    name: relay.name,
    host: relay.host,
    port: relay.port,
    fp: relay.fp,
  };
}
