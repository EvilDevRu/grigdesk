import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { PhoneAddress } from '../../../../shared/client/phonePairing.ts';
import { validPhoneHost } from '../../../../shared/client/phonePairing.ts';
import { MobileInputError } from '../mobile/errors.ts';
import { privateRead, privateWrite, serialized } from '../mobile/files.ts';
import type { MobileService } from '../mobile/service.ts';
import { createClientBootstrap } from './bootstrap.ts';
import type { ClientConfig } from './config.ts';
import { bindClientListener } from './listener.ts';
import type { ClientBudget, ClientListener } from './listener.ts';
import { phoneRelayStatus } from './phoneRelay.ts';
import { parsePhoneConfig } from './phoneAccessConfig.ts';
import type { PhoneAccessConfig } from './phoneAccessConfig.ts';
import { phoneAccessOwners } from './phoneAccessRegistry.ts';

export interface PhoneAccessOptions {
  root: FastifyInstance;
  mobile: MobileService;
  config: {
    mobileDir: string;
    serverName: string;
    clientAccess: ClientConfig;
  };
  dependencies?: {
    networkInterfaces?: typeof networkInterfaces;
    lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
    writeConfig?: typeof privateWrite;
  };
}

interface PhoneIdentity {
  fp: string;
  keyPem: string;
  certPem: string;
}

/**
 * Один владелец согласует durable-настройку, staged bind и действующие TLS-группы.
 * Основной HTTP не меняется; private ingress никогда не публикуется телефону.
 */
export function createPhoneAccess(options: PhoneAccessOptions,
  identity: () => Promise<PhoneIdentity>) {
  const { root, mobile, config } = options;
  const file = path.join(config.mobileDir, 'phone-access.json');
  const budget: ClientBudget = {
    sockets: new Set(),
    unpairedSockets: new Set(),
    deviceSockets: new Map(),
    handshakes: new Map(),
  };
  const groups = new Map<string, ClientListener>();
  let direct: PhoneAccessConfig['direct'] = {
    enabled: config.clientAccess.addresses.length > 0,
    addresses: config.clientAccess.addresses,
  };
  let source: 'saved' | 'env' | 'off' = direct.enabled ? 'env' : 'off';
  let error: string | null = config.clientAccess.reason;
  let bootstrap: Awaited<ReturnType<typeof createClientBootstrap>> | null = null;
  let privateListener: ClientListener | null = null;
  let initialized: Promise<void> | null = null;
  let closed = false;

  const interfaces = () => Object.entries((options.dependencies?.networkInterfaces ?? networkInterfaces)())
    .flatMap(([name, values]) => (values ?? []).filter((item) => item.family === 'IPv4'
      && !item.internal && validPhoneHost(item.address)).map((item) => ({ name, host: item.address })));

  /**
   * Каждая группа использует общий bootstrap и один набор бюджетов всех входов.
   * Сбой новой группы возвращает ошибку до изменения durable-конфигурации.
   */
  async function bind(addresses: PhoneAddress[]) {
    const listener = await bindClientListener({
      addresses,
      identity: await identity(),
      devices: mobile.devices,
      app: root,
      bootstrap: bootstrap!,
      budget,
    });

    if (listener.state().state === 'error') {
      await listener.close();

      throw new MobileInputError('client_bind_failed',
        'Порт занят или сеть недоступна. Выберите другой порт.', 409);
    }

    return listener;
  }

  /**
   * Чтение не создаёт файл и никогда не превращает повреждение в открытый вход.
   * Инициализация выполняется один раз и также доступна раннему relay resolver.
   */
  async function initialize() {
    if (!initialized) {
      initialized = (async () => {
        const serverIdentity = await identity();

        bootstrap = await createClientBootstrap({
          pairing: mobile.pairing,
          identity: () => serverIdentity,
          name: config.serverName,
        });

        try {
          const saved = await privateRead(file) as PhoneAccessConfig | null;

          if (saved) {
            if (saved.version !== 1) {
              throw new Error('bad_version');
            }

            direct = parsePhoneConfig(saved.direct);
            source = 'saved';
            error = null;
          }

          for (const address of direct.enabled ? direct.addresses : []) {
            groups.set(`${address.host}:${address.port}`, await bind([address]));
          }
        } catch (failure) {
          error = failure instanceof MobileInputError && failure.code === 'client_bind_failed'
            ? 'Сохранённая сеть или порт недоступны. Выберите действующую сеть и свободный порт.'
            : 'Настройка прямого доступа повреждена или вход недоступен.';

          for (const group of groups.values()) {
            await group.close();
          }

          groups.clear();
        }
      })();
    }

    await initialized;
  }

  /**
   * Linux не даёт занять ip:port, пока тот же порт держит wildcard-вход этого сервера.
   * Сужение «все сети → одна» освобождает ненужный wildcard перед bind; при любом
   * последующем отказе вызывающий восстанавливает его, и прежний доступ сохраняется.
   */
  async function bindReleasingWildcard(address: PhoneAddress, desired: Set<string>,
    released: PhoneAddress[]) {
    try {
      return await bind([address]);
    } catch (failure) {
      const key = `0.0.0.0:${address.port}`;
      const wildcard = groups.get(key);

      if (!(failure instanceof MobileInputError) || failure.code !== 'client_bind_failed'
        || !wildcard || desired.has(key)) {
        throw failure;
      }

      groups.delete(key);
      await wildcard.close();
      released.push({ host: '0.0.0.0', port: address.port });

      return bind([address]);
    }
  }

  /**
   * Откат возвращает освобождённые входы прежней настройки после отказа перехода.
   * Неудачное восстановление видно в статусе, а не скрыто за ошибкой нового bind.
   */
  async function restore(released: PhoneAddress[]) {
    for (const address of released) {
      try {
        groups.set(`${address.host}:${address.port}`, await bind([address]));
      } catch {
        error = 'Прежний вход на всех сетях не восстановлен. Выберите сеть и порт заново.';
      }
    }
  }

  /**
   * Изменение сериализует весь переход, включая открытие и откат staged-сокетов.
   * Старые группы закрываются только после успешной устойчивой записи файла; исключение —
   * wildcard того же порта, который освобождается для bind и восстанавливается при отказе.
   */
  async function configure(input: unknown) {
    await initialize();

    return serialized(file, async () => {
      const next = parsePhoneConfig(input);
      const available = new Set(interfaces().map((item) => item.host));
      const staged = new Map<string, ClientListener>();
      const released: PhoneAddress[] = [];
      const desired = new Set(next.addresses.map((address) => `${address.host}:${address.port}`));

      if (next.addresses.some((address) => !available.has(address.host))) {
        throw new MobileInputError('bad_network', 'Выберите IPv4 действующей сети этого сервера.');
      }

      try {
        for (const address of next.addresses) {
          const key = `${address.host}:${address.port}`;

          if (!groups.has(key) && !staged.has(key)) {
            staged.set(key, await bindReleasingWildcard(address, desired, released));
          }
        }

        await (options.dependencies?.writeConfig ?? privateWrite)(file,
          JSON.stringify({ version: 1, direct: next }, null, 2));
      } catch (failure) {
        await Promise.all([...staged.values()].map((group) => group.close()));
        await restore(released);

        throw failure;
      }

      direct = next;
      source = 'saved';
      error = null;

      for (const [key, group] of staged) {
        groups.set(key, group);
      }

      for (const [key, group] of groups) {
        if (!desired.has(key)) {
          groups.delete(key);
          await group.close();
        }
      }

      return status();
    });
  }

  /**
   * DNS проверяется сервером перед публикацией, а не адресом окна пользователя.
   * Неоднозначный wildcard требует явного выбора; QR не доказывает достижимость.
   */
  async function candidates(selected?: PhoneAddress[]): Promise<PhoneAddress[]> {
    await initialize();

    const networks = interfaces();
    let result = selected ?? direct.advertised;

    if (!result && !error && direct.enabled) {
      // Адрес из окружения описывает только вход из окружения; сохранённая настройка важнее.
      if (config.clientAccess.address && source === 'env') {
        const [host, port] = config.clientAccess.address.split(':');

        result = [{ host: host!, port: Number(port) }];
      } else {
        result = direct.addresses.flatMap((address) => address.host === '0.0.0.0'
          ? networks.map((item) => ({ host: item.host, port: address.port }))
          : validPhoneHost(address.host) ? [address] : []);

        if (direct.addresses.some((address) => address.host === '0.0.0.0') && networks.length > 1) {
          throw new MobileInputError('choose_address', 'Выберите сеть или введите адрес сервера.', 409);
        }
      }
    }

    result = result?.map((address) => ({
      ...address,
      host: typeof address.host === 'string' ? address.host.toLowerCase() : address.host,
    }));

    for (const address of result ?? []) {
      if (!validPhoneHost(address.host) || !Number.isInteger(address.port)
        || address.port < 1 || address.port > 65535) {
        throw new MobileInputError('bad_client_address', 'Укажите доступный телефону сетевой адрес.');
      }

      if (!isIP(address.host)) {
        const resolve = options.dependencies?.lookup ?? ((host: string) => lookup(host, { all: true }));
        const values = await resolve(address.host);

        if (!values.some((item) => item.family === 4 && validPhoneHost(item.address))) {
          throw new MobileInputError('bad_client_address', 'Имя сервера не имеет подходящего сетевого IPv4.');
        }
      }
    }

    return result ?? [];
  }

  /**
   * Публичный снимок не включает ключи устройств и токены ретрансляторов.
   * Источник настройки позволяет отличить сохранённое решение от окружения машины.
   */
  async function status() {
    await initialize();

    return {
      name: config.serverName,
      source,
      direct: {
        ...direct,
        state: error ? 'error' : groups.size ? 'online' : 'disabled',
        error,
      },
      networks: interfaces(),
      relays: (await mobile.status()).relays.map((relay) => ({ ...relay, ...phoneRelayStatus(relay) })),
    };
  }

  const facade: ClientListener = {
    state: () => ({
      state: error ? 'error' : groups.size ? 'online' : 'disabled',
      addresses: [...groups.keys()],
      error,
    }),
    /**
     * Отзыв одновременно охватывает прямые и приватные TLS-соединения.
     * Durable-реестр уже обновлён вызывающей административной операцией.
     */
    disconnect(fp) {
      for (const group of [...groups.values(), ...(privateListener ? [privateListener] : [])]) {
        group.disconnect(fp);
      }
    },
    /**
     * Shutdown фасада закрывает все собственные группы и bootstrap.
     * Повторный вызов не касается основного HTTP или чужих процессов.
     */
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      await initialize();
      await Promise.all([...groups.values(), ...(privateListener ? [privateListener] : [])]
        .map((group) => group.close()));
      groups.clear();
      await bootstrap?.close();
    },
  };

  phoneAccessOwners.set(root, { async start() {
    await initialize();

    return facade;
  } });
  mobile.setClientTarget(async () => {
    await initialize();

    return serialized(`${file}:private`, async () => {
      if (!privateListener) {
        privateListener = await bind([{ host: '127.0.0.1', port: 0 }]);
      }

      return Number(privateListener.state().addresses[0]!.split(':').at(-1));
    });
  });

  return {
    status,
    configure,
    candidates,
    facade,
  };
}
