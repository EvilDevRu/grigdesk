import { promises as fs } from 'node:fs';
import path from 'node:path';

import { MobileInputError } from './errors.ts';
import { ensureBrainIdentity, renderRelayEnv } from './identity.ts';
import { PairingCodes } from './pairing.ts';
import { RelayHub } from './relayHub.ts';
import { DeviceStore, RelayStore } from './store.ts';
import type { Relay } from './store.ts';
import { RelayDeploymentService } from './relayDeployment/service.ts';
import type { DeploymentOptions } from './relayDeployment/service.ts';

type Hub = Pick<RelayHub, 'sync' | 'close' | 'status'>;

type Options = {
  directory: string;
  vpnGate: (ip: string) => Promise<boolean>;
  changed?: () => void;
  disconnectClient?: (fp: string) => void;
  log?: (event: string) => void;
  relayDeployment?: DeploymentOptions;
  makeHub?: (options: ConstructorParameters<typeof RelayHub>[0]) => Hub;
};

/**
 * Владеет реестром устройств, личностью сервера и исходящими связями с посредниками.
 * Ошибка хранилища или ключа не прерывает основной сервер GrigDesk.
 */
export class MobileService {
  readonly devices: DeviceStore;
  readonly relays: RelayStore;
  readonly pairing: PairingCodes;
  private options: Options;
  private hub: Hub | null = null;
  private identity: Awaited<ReturnType<typeof ensureBrainIdentity>> | null = null;
  private error: string | null = null;
  private deployments?: RelayDeploymentService;
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
   * Перед запуском хаба проверяет оба списка и согласованность пары ключ/сертификат.
   */
  async start() {
    if (this.hub) {
      return;
    }

    try {
      const relays = await this.relays.list();

      await this.devices.list();
      this.identity = await ensureBrainIdentity(this.options.directory);

      this.error = null;

      this.hub = (this.options.makeHub ?? ((options) => new RelayHub(options)))({
        clientTarget: this.clientTarget,
        vpnGate: this.options.vpnGate,
        changed: this.options.changed,
      });
      this.hub.sync(relays);

      if (this.options.relayDeployment) {
        this.deployments = new RelayDeploymentService(this.options.directory, this,
          this.options.relayDeployment, {
            fp: () => this.identity!.fp,
            vpnGate: this.options.vpnGate,
            clientTarget: async () => {
              if (!this.clientTarget) {
                throw new Error('client_listener_unavailable');
              }

              return this.clientTarget();
            },
            changed: () => this.options.changed?.(),
            sync: async () => this.hub!.sync(await this.relays.list()),
          });

        await this.deployments.recover().catch(() => {
          this.deployments = undefined;
          this.options.log?.('deployment_store_unavailable');
        });
      }
    } catch {
      await this.close();
      this.error = 'Мобильный доступ не запущен. Проверьте настройки и личность сервера.';
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
          fp: this.identity?.fp ?? null,
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
      };
    } catch {
      await this.close();
      this.error = 'Настройки мобильного доступа повреждены.';

      return {
        server: {
          fp: this.identity?.fp ?? null,
          error: this.error,
        },
        relays: [],
      };
    }
  }

  /**
   * Повреждённый deployment journal закрывает только мастер, сохраняя ручную настройку и прямой доступ.
   * Экземпляр создаётся после загрузки identity и принадлежит серверному lifecycle.
   */
  deploymentService(): RelayDeploymentService {
    if (!this.deployments) {
      throw new MobileInputError('deployment_unavailable', 'Мастер удалённого доступа недоступен.', 503);
    }

    return this.deployments;
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
   * Для изменения списка хаб и личность сервера должны быть готовы.
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

    if (this.deployments) {
      await this.deployments.withRelayRemoval(id, () => this.relays.remove(id));
    } else {
      await this.relays.remove(id);
    }

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

    this.options.disconnectClient?.(device.fp);
    this.options.changed?.();
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
   * Закрывает связи с посредниками и мастер при остановке или ошибке старта.
   * Повторное закрытие не затрагивает чужие процессы.
   */
  async close() {
    await this.deployments?.close();
    this.deployments = undefined;
    this.hub?.close();
    this.hub = null;
  }
}

/**
 * Общий безопасный вид посредника для настроек.
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
