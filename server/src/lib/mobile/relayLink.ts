import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

import type { Relay } from './store.ts';
import { dialRelay, relayHello, relayLine } from './transport.ts';

export type RelayState = 'connecting' | 'online' | 'waiting_vpn' | 'offline' | 'error';

/**
 * Различает разрешённые локальные адреса и публичный IP для VPN-проверки.
 * IPv4-mapped адрес нормализуется; неопределённый, multicast и scoped host запрещены.
 */
export function normalizeRelayIp(input: string): {
  ip: string;
  private: boolean;
} {
  let ip = input.toLowerCase();

  if (net.isIP(ip) === 6 && !ip.includes('%')) {
    ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  }

  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) {
    ip = ip.slice(7);
  }

  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(ip);

  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);

    ip = [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }

  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0]!;
    const b = parts[1]!;

    if (a === 0 || a >= 224 || (a === 169 && b === 254)) {
      throw new Error('relay_bad_address');
    }

    return {
      ip,
      private:
        ip === '127.0.0.1' ||
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168),
    };
  }

  if (
    net.isIP(ip) !== 6 ||
    ip.includes('%') ||
    ip === '::' ||
    ip.startsWith('ff') ||
    /^fe[89ab]/.test(ip) ||
    ip.startsWith('::ffff:')
  ) {
    throw new Error('relay_bad_address');
  }

  return {
    ip,
    private: ip === '::1' || /^(fc|fd)/.test(ip),
  };
}

/**
 * Reconnect растёт экспоненциально до ограниченного базового интервала.
 * Jitter разводит одновременное восстановление нескольких посредников.
 */
export function nextDelay(attempt: number, random = Math.random): number {
  return Math.round(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + random() * 0.4));
}

export class RelayLink {
  readonly relay: Relay;
  private mobilePort: number;
  private vpnGate: (ip: string) => Promise<boolean>;
  private changed: () => void;
  private state: RelayState = 'offline';
  private since = Date.now();
  private lastError: string | null = null;
  private control: TLSSocket | null = null;
  private pairs = new Map<
    TLSSocket,
    {
      ip: string;
      local: Socket | null;
    }
  >();
  private abort = new AbortController();
  private stopped = true;
  private generation = 0;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private monitor: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  private controlIp: string | null = null;
  private incomingCount = 0;

  constructor(options: {
    relay: Relay;
    mobilePort: number;
    vpnGate: (ip: string) => Promise<boolean>;
    changed?: () => void;
  }) {
    this.relay = options.relay;
    this.mobilePort = options.mobilePort;
    this.vpnGate = options.vpnGate;
    this.changed = options.changed ?? (() => {});
  }

  status() {
    return {
      id: this.relay.id,
      state: this.state,
      since: this.since,
      lastError: this.lastError,
      pipes: this.pairs.size,
    };
  }

  /**
   * Состояние и время перехода публикуются одним владельцем control-соединения.
   * Callback уведомляет админский интерфейс без передачи токенов посредника.
   */
  private setState(state: RelayState, error: string | null = null) {
    this.state = state;
    this.lastError = error;
    this.since = Date.now();
    this.changed();
  }

  /**
   * Разрешает DNS один раз и возвращает именно проверенный числовой адрес.
   * Глобальное отключение VPN-ворот других функций не применяется к посреднику.
   */
  private async address() {
    const resolved = net.isIP(this.relay.host)
      ? this.relay.host
      : (await lookup(this.relay.host)).address;
    const address = normalizeRelayIp(resolved);

    if (!address.private && !(await this.vpnGate(address.ip))) {
      throw new Error('waiting_vpn');
    }

    return address.ip;
  }

  /**
   * Отменяет свои dial и все пары при stop, удалении или потере VPN.
   * Обрыв одного control отдельно не закрывает уже готовые пары.
   */
  private disconnect() {
    this.generation += 1;
    this.abort.abort();
    this.abort = new AbortController();
    this.control?.destroy();
    this.control = null;

    for (const [socket, pair] of this.pairs) {
      socket.destroy();
      pair.local?.destroy();
    }

    this.pairs.clear();
  }

  /**
   * Проверяет маршруты публичных соединений каждую секунду.
   * Это монитор доступности; системный kill switch проверяется отдельно при эксплуатации.
   */
  private async checkVpn() {
    if (this.checking || this.stopped) {
      return;
    }

    this.checking = true;

    const generation = this.generation;

    try {
      const ips = new Set([...this.pairs.values()].map((pair) => pair.ip));

      if (this.controlIp) {
        ips.add(this.controlIp);
      }

      for (const ip of ips) {
        if (!normalizeRelayIp(ip).private && !(await this.vpnGate(ip))) {
          if (generation === this.generation && !this.stopped) {
            clearTimeout(this.retry);
            this.disconnect();
            this.setState('waiting_vpn');
            this.schedule();
          }

          return;
        }
      }
    } catch {
      if (generation === this.generation && !this.stopped) {
        this.disconnect();
        this.setState('waiting_vpn');
        this.schedule();
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * Ставит только один следующий connect с ограниченным случайным backoff.
   * Stop и новое поколение отменяют запоздалые асинхронные результаты.
   */
  private schedule() {
    clearTimeout(this.retry);

    if (!this.stopped) {
      this.retry = setTimeout(() => {
        void this.connect();
      }, nextDelay(this.attempt++));
    }
  }

  /**
   * Открывает отдельный brain-data после проверки адреса для каждого incoming.
   * Локальный connect ограничен временем; pipe не создаёт очереди копий трафика.
   */
  private async incoming(id: string) {
    if (this.pairs.size + this.incomingCount >= 32 || !/^[a-f0-9]{32}$/.test(id)) {
      return;
    }

    this.incomingCount += 1;

    const generation = this.generation;
    let remote: TLSSocket | null = null;
    let local: Socket | null = null;

    try {
      const ip = await this.address();

      if (this.stopped || generation !== this.generation) {
        return;
      }

      remote = await dialRelay({
        ip,
        port: this.relay.port,
        fp: this.relay.fp,
        signal: this.abort.signal,
      });
      this.pairs.set(remote, {
        ip,
        local: null,
      });
      remote.once('close', () => {
        this.pairs.delete(remote!);
        local?.destroy();
      });
      await relayHello(remote, {
        v: 1,
        role: 'brain-data',
        token: this.relay.brainToken,
        id,
      });

      if (this.stopped || generation !== this.generation) {
        remote.destroy();

        return;
      }

      local = net.connect({
        host: '127.0.0.1',
        port: this.mobilePort,
      });

      const target = local;
      const source = remote;
      const timer = setTimeout(() => target.destroy(), 10000);

      target.once('connect', () => clearTimeout(timer));
      target.once('close', () => {
        clearTimeout(timer);
        source.destroy();
      });
      target.on('error', () => source.destroy());
      target.setKeepAlive(true, 30000);
      this.pairs.set(remote, {
        ip,
        local,
      });
      remote.pipe(local);
      local.pipe(remote);
    } catch {
      remote?.destroy();
      local?.destroy();
    } finally {
      this.incomingCount -= 1;
    }
  }

  /**
   * Ведёт поколение control с одним reader и ping/pong.
   * Любой malformed control закрывает связь; наружу передаются только фиксированные ошибки.
   */
  private async connect() {
    const generation = this.generation;
    let socket: TLSSocket | null = null;
    let ping: ReturnType<typeof setInterval> | undefined;
    let connectedAt = 0;

    this.setState('connecting');

    try {
      const ip = await this.address();

      if (this.stopped || generation !== this.generation) {
        return;
      }

      this.controlIp = ip;
      socket = await dialRelay({
        ip,
        port: this.relay.port,
        fp: this.relay.fp,
        signal: this.abort.signal,
      });
      await relayHello(socket, {
        v: 1,
        role: 'brain-control',
        token: this.relay.brainToken,
      });

      if (this.stopped || generation !== this.generation) {
        socket.destroy();

        return;
      }

      this.control = socket;
      connectedAt = performance.now();
      this.setState('online');
      ping = setInterval(() => socket?.write('{"t":"ping"}\n'), 20000);

      while (!this.stopped && generation === this.generation) {
        const message = JSON.parse(await relayLine(socket)) as {
          t?: string;
          id?: string;
        };

        if (message.t === 'ping') {
          socket.write('{"t":"pong"}\n');
        } else if (message.t === 'incoming' && typeof message.id === 'string') {
          void this.incoming(message.id);
        } else if (message.t !== 'pong') {
          throw new Error('relay_bad_reply');
        }
      }
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        const message = error instanceof Error ? error.message : '';

        if (message === 'waiting_vpn') {
          this.setState('waiting_vpn');
        } else {
          this.setState('error', message === 'relay_pin_mismatch' ? message : 'relay_disconnected');
        }
      }
    } finally {
      clearInterval(ping);
      socket?.destroy();

      if (this.control === socket) {
        this.control = null;
      }

      if (!this.stopped && generation === this.generation) {
        if (connectedAt && performance.now() - connectedAt >= 60000) {
          this.attempt = 0;
        }

        this.schedule();
      }
    }
  }

  /**
   * Начинает связь ровно один раз для данного экземпляра посредника.
   * Монитор и reconnect принадлежат этому объекту, а не админ-ручкам.
   */
  start() {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.monitor = setInterval(() => {
      void this.checkVpn();
    }, 1000);
    void this.connect();
  }

  /**
   * Завершает все собственные соединения и таймеры при shutdown или удалении.
   * Новое поколение не позволяет старому dial восстановить закрытую пару.
   */
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.monitor);
    this.disconnect();
    this.controlIp = null;
    this.setState('offline');
  }
}
