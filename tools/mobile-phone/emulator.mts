import { createServer } from 'node:http';
import https from 'node:https';
import type { ClientRequest, IncomingHttpHeaders } from 'node:http';
import tls from 'node:tls';
import { randomBytes, X509Certificate, timingSafeEqual, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';

import { parseQr } from '../../mobile/src/link/qr.ts';
import type { QrPayload } from '../../mobile/src/link/qr.ts';
import type { LinkState, OperationIntent, RequestInput } from '../../mobile/src/link/types.ts';
import { dialRelay, relayHello } from '../../server/src/lib/mobile/transport.ts';
import { allowedRequest } from './routes.mts';
import { rasterSize, evictMedia } from './media.mts';
import { decodeContract } from '../../mobile/src/api/contract.ts';
import type { AppUpdate } from '../../mobile/src/api/contract.ts';

const execute = promisify(execFile);
const PREFIX = '/api/mobile/v1/';

/**
 * Ошибки сокета и протокола посредника означают временную потерю сети, а не отказ команды.
 * Только известные терминальные причины закрывают сессию или требуют решения человека.
 */
export function transportCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';

  if (code.includes('pin')) {
    return 'pin_mismatch';
  }
  if (
    [
      'locked',
      'device_revoked',
      'device_unknown',
      'contract',
      'bad_route',
      'bad_operation',
      'outbox_full',
      'idempotency_conflict',
    ].includes(code)
  ) {
    return code;
  }

  return 'network';
}

/**
 * Даже dev-хранилище читается через собственный regular file без symlink и без роста буфера.
 * Дополнительный байт обнаруживает превышение лимита, прежде чем JSON попадает в память приложения.
 */
async function boundedText(file: string, limit: number) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));

  try {
    const information = await handle.stat();

    if (!information.isFile() || information.size > limit) {
      throw new Error('store_corrupt');
    }

    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;

    while (offset <= limit) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);

      if (!result.bytesRead) {
        break;
      }

      offset += result.bytesRead;
    }

    if (offset > limit) {
      throw new Error('store_corrupt');
    }

    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Внешний intent и восстановленная очередь проверяются одним правилом до записи или отправки.
 * GET не является изменением состояния, поэтому его нельзя сохранить в durable outbox.
 */
function validIntent(item: any): item is OperationIntent {
  return (
    item?.method === 'POST' &&
    allowedRequest(item.method, item.path) &&
    typeof item.body === 'string' &&
    /^[A-Za-z0-9_-]{8,80}$/.test(item.idempotencyKey || '') &&
    Number.isSafeInteger(item.createdAt) &&
    item.createdAt > 0
  );
}

export type DeviceIdentity = {
  key: string;
  cert: string;
};

export type IdentityStore = {
  load(directory: string): Promise<DeviceIdentity>;
  create(directory: string, name: string): Promise<DeviceIdentity>;
};

export type PhoneOptions = {
  monotonic?: () => number;
  identity?: IdentityStore;
  deviceName?: string;
  unlockMs?: number;
};

/**
 * Ключ DevLink и тестов: синтетическая пара от openssl в открытых файлах каталога.
 * Клиент для компьютера подставляет своё хранилище под защитой ОС.
 */
export const opensslIdentity: IdentityStore = {
  async load(directory) {
    return {
      key: await boundedText(path.join(directory, 'device-key.pem'), 16384),
      cert: await boundedText(path.join(directory, 'device-cert.pem'), 16384),
    };
  },
  /**
   * Сохраняет прежнюю генерацию синтетического ключа DevLink через openssl.
   * Desktop заменяет всё хранилище, поэтому открытый PEM туда не попадает.
   */
  async create(directory) {
    const keyFile = path.join(directory, 'device-key.pem');
    const certFile = path.join(directory, 'device-cert.pem');

    await execute('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '30',
      '-subj',
      '/CN=cockpit-emulator',
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ]);

    return {
      key: await readFile(keyFile, 'utf8'),
      cert: await readFile(certFile, 'utf8'),
    };
  },
};

/**
 * Node-движок связи телефона: DevLink держит синтетический ключ, desktop — ключ под защитой ОС.
 * Options задаёт хранилище ключа, имя устройства и срок разблокировки без копии транспорта.
 */
export class PhoneEmulator {
  readonly directory: string;
  state: LinkState = {
    paired: false,
    brainName: '',
    deviceName: 'Эмулятор телефона',
    relays: [],
    activeRelayId: null,
    unlocked: false,
    fontScale: 1,
    generation: 0,
  };
  private qr: QrPayload | null = null;
  private relays = new Map<string, QrPayload['relay']>();
  private sockets = new Set<tls.TLSSocket>();
  private calls = new Set<ClientRequest>();
  private deadline = 0;
  private monotonic: () => number;
  private identity: IdentityStore;
  private unlockMs: number;
  private key = '';
  private cert = '';
  private outbox: OperationIntent[] = [];
  private listeners = new Set<(name: string, value: unknown) => void>();
  private eventsWanted = false;
  private eventsWork: Promise<void> | null = null;
  private lastActivity = 0;
  private liveReadyEvent: {
    name: string;
    data: string;
    generation: number;
  } | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectResolve: (() => void) | null = null;
  private mediaActive = 0;
  private restActive = 0;
  private restWaiting = new Set<() => void>();
  private cleanup: Promise<unknown> = Promise.resolve();
  private outboxWork: Promise<unknown> = Promise.resolve();

  constructor(directory: string, options: PhoneOptions | (() => number) = {}) {
    const normalized = typeof options === 'function' ? { monotonic: options } : options;
    const unlockMs = normalized.unlockMs ?? 600000;

    if (!Number.isSafeInteger(unlockMs) || unlockMs <= 0) {
      throw new Error('bad_input');
    }

    this.directory = directory;
    this.monotonic = normalized.monotonic ?? (() => performance.now());
    this.identity = normalized.identity ?? opensslIdentity;
    this.unlockMs = unlockMs;
    this.state.deviceName = normalized.deviceName ?? 'Эмулятор телефона';
  }

  /**
   * Перезапуск читает прежний синтетический ключ и intent, оставляя приложение заблокированным.
   * Повреждённый файл не трактуется как новая пустая привязка.
   */
  async load() {
    try {
      let config;

      try {
        config = JSON.parse(await boundedText(path.join(this.directory, 'link.json'), 262144));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }

        throw error;
      }

      if (!Array.isArray(config.relays) || config.relays.length > 64) {
        throw new Error('store_corrupt');
      }

      const qrText = (value: unknown) =>
        'cockpitlink:1:' + Buffer.from(JSON.stringify(value)).toString('base64url');
      const qr = parseQr(qrText(config.qr));
      const relayList = config.relays.map((relay: QrPayload['relay']) => parseQr(qrText({
        v: 1,
        brain: qr.brain,
        relay,
      })).relay);
      const relays = new Map<string, QrPayload['relay']>(relayList.map(
        (relay: QrPayload['relay']) => [relay.id, relay],
      ));

      if (relays.size !== relayList.length ||
        (config.activeRelayId !== null && !relays.has(config.activeRelayId))) {
        throw new Error('store_corrupt');
      }

      const identity = await this.identity.load(this.directory);
      const paired = await boundedText(path.join(this.directory, 'paired.json'), 4096).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return '{}';
          }

          throw error;
        },
      );
      const device = JSON.parse(paired).device;

      if (device && (typeof device.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(device.id))) {
        throw new Error('store_corrupt');
      }

      const outbox: OperationIntent[] = JSON.parse(
        await boundedText(path.join(this.directory, 'outbox.json'), 2 * 1024 * 1024).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
              return '[]';
            }

            throw error;
          },
        ),
      );

      if (!Array.isArray(outbox) || outbox.length > 100 || !outbox.every(validIntent) ||
        new Set(outbox.map((item) => item.idempotencyKey)).size !== outbox.length) {
        throw new Error('store_corrupt');
      }

      // Вся конфигурация проверена: отказ выше не публикует частично восстановленное состояние.
      this.qr = qr;
      this.relays = relays;
      this.key = identity.key;
      this.cert = identity.cert;
      this.outbox = outbox;
      this.state.activeRelayId = config.activeRelayId;
      this.state.brainName = qr.brain.name;
      this.state.paired = Boolean(device);
      this.state.deviceId = device?.id;
      this.refreshRelays();
    } catch (error) {
      if (error instanceof Error && error.message === 'secure_store_unavailable') {
        throw error;
      }

      throw new Error('store_corrupt');
    }
  }

  subscribe(listener: (name: string, value: unknown) => void) {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  private emit(name: string, value: unknown) {
    this.listeners.forEach((listener) => listener(name, value));
  }

  /**
   * Каждый доступ проверяет monotonic deadline; старое поколение отказывает до выдачи данных.
   * Lock закрывает sockets/calls, но durable очередь сохраняется для следующего unlock.
   */
  private gate(generation = this.state.generation) {
    if (
      !this.state.unlocked ||
      this.monotonic() >= this.deadline ||
      generation !== this.state.generation
    ) {
      if (this.state.unlocked && this.monotonic() >= this.deadline) {
        this.lock();
      }

      throw new Error(this.state.revoked ? 'device_revoked' : 'locked');
    }
  }

  getState() {
    if (this.state.unlocked && this.monotonic() >= this.deadline) {
      this.lock();
    }

    return structuredClone(this.state);
  }

  /**
   * Диагностика стенда показывает только счётчики ресурсов, без ключей и содержимого запросов.
   * Она помогает отличать потерянный ready от заблокированной очереди и проверять уборку.
   */
  diagnostics() {
    return {
      sockets: this.sockets.size,
      calls: this.calls.size,
      eventsWanted: this.eventsWanted,
      rest: this.restActive,
      media: this.mediaActive,
      outbox: this.outbox.length,
    };
  }

  /**
   * Dev unlock выдаёт новое поколение после закрытия всех прежних соединений.
   * Срок вычисляется по monotonic часам, а не записывается в вечный boolean.
   */
  unlock() {
    this.lock();
    this.state.unlocked = true;
    this.deadline = this.monotonic() + this.unlockMs;
    this.emit('linkState', this.getState());
  }

  /**
   * Барьер закрывает весь транспорт и стирает media до уведомления браузера.
   * reconnect timer отменяется вместе с поколением и не держит процесс после close.
   */
  lock() {
    this.state.generation += 1;
    this.state.unlocked = false;
    this.stopEvents();
    this.calls.forEach((call) => call.destroy(new Error('locked')));
    this.sockets.forEach((socket) => socket.destroy());
    this.calls.clear();
    this.sockets.clear();
    this.cleanup = this.cleanup
      .then(() =>
        Promise.all(
          ['media', 'updates'].map((name) =>
            rm(path.join(this.directory, name), {
              recursive: true,
              force: true,
            }),
          ),
        ),
      )
      .catch(() => {});
    this.restWaiting.forEach((wake) => wake());
    this.restWaiting.clear();
    this.emit('linkState', {
      ...this.state,
      state: this.state.revoked ? 'revoked' : 'locked',
    });
  }

  /**
   * QR сохраняет pending identity до первого pair, а тот же сертификат завершает потерянный ACK.
   * Другой мозг и смена пина существующего relay отвергаются до подключения.
   */
  async addFromText(text: string) {
    const payload = parseQr(text);

    if (this.qr && this.qr.brain.fp !== payload.brain.fp) {
      throw new Error('Телефон привязан к другому мозгу. Сначала отвяжите его.');
    }

    const previous = this.relays.get(payload.relay.id);

    if (previous && previous.fp !== payload.relay.fp) {
      throw new Error('Пин посредника изменился. Удалите прежнюю запись.');
    }

    this.unlock();
    await mkdir(this.directory, {
      recursive: true,
      mode: 0o700,
    });

    if (!this.cert) {
      const identity = await this.identity.create(this.directory, this.state.deviceName);

      this.key = identity.key;
      this.cert = identity.cert;
    }

    this.qr = payload;
    this.relays.set(payload.relay.id, payload.relay);
    this.state.brainName = payload.brain.name;
    this.state.activeRelayId = payload.relay.id;
    this.refreshRelays();
    await this.persist(
      'link.json',
      JSON.stringify({
        qr: payload,
        relays: [...this.relays.values()],
        activeRelayId: this.state.activeRelayId,
      }),
    );

    const hello = await this.raw({
      method: 'GET',
      path: PREFIX + 'hello',
    });
    const value = JSON.parse(hello.body);
    let device = value.device;

    if (!device) {
      if (!payload.pair) {
        throw new Error('Нужен QR для привязки телефона.');
      }

      const response = await this.raw({
        method: 'POST',
        path: PREFIX + 'pair',
        body: JSON.stringify({
          code: payload.pair.code,
          name: this.state.deviceName,
        }),
      });

      if (response.status !== 200) {
        throw new Error(JSON.parse(response.body).error || 'pair_failed');
      }

      device = JSON.parse(response.body).device;
    }

    this.state.paired = true;
    this.state.deviceId = device.id;
    await this.persist('paired.json', JSON.stringify({ device }));
    this.emit('linkState', {
      ...this.state,
      state: 'online',
    });
  }

  private refreshRelays() {
    this.state.relays = [...this.relays.values()].map(({ id, name, host, port }) => ({
      id,
      name,
      host,
      port,
      state: 'online',
    }));
  }

  /**
   * Смена посредника отзывает generation и pools, сохраняя прежний deadline разблокировки.
   * Durable выбор и pending intents переживают перезапуск dev-эмулятора.
   */
  async selectRelay(id: string) {
    this.gate();

    if (!this.relays.has(id)) {
      throw new Error('relay_unknown');
    }

    const deadline = this.deadline;
    const wanted = this.eventsWanted;

    this.lock();
    await this.cleanup;
    this.state.activeRelayId = id;
    this.state.unlocked = true;
    this.deadline = deadline;
    await this.persistConfig();
    this.emit('linkState', this.getState());

    if (wanted) {
      this.startEvents();
    }
  }

  /**
   * Удаление активного посредника закрывает транспорт без неявного выбора другой записи.
   * Остальные записи сохраняют pin и identity мозга в собственном dev-хранилище.
   */
  async removeRelay(id: string) {
    this.gate();

    if (this.state.activeRelayId === id) {
      this.lock();
      this.state.activeRelayId = null;
    }

    this.relays.delete(id);
    this.refreshRelays();
    await this.persistConfig();
  }

  private persistConfig() {
    return this.persist(
      'link.json',
      JSON.stringify({
        qr: this.qr,
        relays: [...this.relays.values()],
        activeRelayId: this.state.activeRelayId,
      }),
    );
  }

  /**
   * Внутренний TLS стартует только после проверки relay pin и ok, с клиентским сертификатом.
   * Brain pin проверяется до первого HTTP байта; оба сокета принадлежат захваченному generation.
   */
  private async connect(generation: number) {
    this.gate(generation);

    const relay = this.relays.get(this.state.activeRelayId || '');

    if (!relay || !this.qr || this.sockets.size >= 8) {
      throw new Error('network');
    }

    let outer: tls.TLSSocket | null = null;

    try {
      const connected = await dialRelay({
        ip: relay.host,
        port: relay.port,
        fp: relay.fp,
      });

      outer = connected;
      this.sockets.add(connected);
      connected.once('close', () => this.sockets.delete(connected));
      this.gate(generation);
      await relayHello(outer, {
        v: 1,
        role: 'device',
        token: relay.token,
      });
      this.gate(generation);

      const inner = tls.connect({
        socket: outer,
        key: this.key,
        cert: this.cert,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: false,
      });

      await new Promise<void>((resolve, reject) => {
        inner.once('secureConnect', resolve);
        inner.once('error', reject);
      });

      if (
        inner.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase() !==
        this.qr.brain.fp
      ) {
        inner.destroy();

        throw new Error('brain_pin_mismatch');
      }

      this.gate(generation);

      return inner;
    } catch (error) {
      outer?.destroy();

      if (transportCode(error) === 'pin_mismatch' && generation === this.state.generation) {
        this.lock();
        this.emit('linkState', {
          state: 'pin_mismatch',
          generation: this.state.generation,
          unlocked: false,
        });
      }

      throw error;
    }
  }

  /**
   * REST проходит один allowlist и отдаёт только bounded JSON текущего generation.
   * Pair/media/SSE используют отдельные private вызовы, недоступные произвольному request.
   */
  async request(input: RequestInput) {
    if (!allowedRequest(input.method, input.path)) {
      throw new Error('bad_route');
    }
    if (input.method === 'POST') {
      await this.putOutbox(input as OperationIntent);
    }

    return this.raw(input);
  }

  /**
   * Внутренний HTTP использует подготовленный pinned TLS socket вместо DNS или proxy.
   * Каждый ответ ограничен по размеру и сверяется с захваченным поколением.
   */
  private async raw(input: RequestInput) {
    const generation = this.state.generation;

    this.gate(generation);

    while (this.restActive >= 4) {
      if (this.restWaiting.size >= 64) {
        throw new Error('network');
      }

      await new Promise<void>((resolve) => this.restWaiting.add(resolve));
      this.gate(generation);
    }

    this.restActive += 1;

    try {
      return await new Promise<{
        status: number;
        body: string;
        generation: number;
      }>((resolve, reject) => {
        const agent = new https.Agent({
          keepAlive: false,
          maxSockets: 4,
        });

        agent.createConnection = (_options, callback) => {
          void this.connect(generation).then(
            (socket) => {
              callback?.(null, socket);
            },
            (error) => {
              callback?.(error, undefined as never);
            },
          );

          return undefined as never;
        };

        const call = https.request(
          {
            hostname: '127.0.0.1',
            port: 443,
            path: input.path,
            method: input.method,
            agent,
            headers: {
              'content-type': 'application/json',
              ...(input.idempotencyKey
                ? {
                    'idempotency-key': input.idempotencyKey,
                    'x-cockpit-operation-created-at': String(input.createdAt),
                  }
                : {}),
            },
          },
          (response) => {
            const parts: Buffer[] = [];
            let size = 0;

            response.on('data', (part: Buffer) => {
              size += part.length;

              if (size > 2 * 1024 * 1024) {
                call.destroy(new Error('contract'));
              } else {
                parts.push(part);
              }
            });
            response.on('error', reject);
            response.on('end', () => {
              try {
                this.gate(generation);

                const body = Buffer.concat(parts).toString('utf8');

                if (response.statusCode === 403) {
                  this.state.revoked = JSON.parse(body).error === 'device_revoked';
                  this.lock();
                }

                resolve({
                  status: response.statusCode || 0,
                  body,
                  generation,
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );

        this.calls.add(call);
        call.once('close', () => {
          this.calls.delete(call);
          agent.destroy();
        });
        call.on('error', reject);
        call.setTimeout(60000, () => call.destroy(new Error('network')));
        call.end(input.body);
      });
    } finally {
      this.restActive -= 1;

      const wake = this.restWaiting.values().next().value;

      if (wake) {
        this.restWaiting.delete(wake);
        wake();
      }
    }
  }

  /**
   * Durable запись выполняется до POST; mutation serialiser сохраняет общий порядок очереди.
   * Внешний key не может заменить другой payload или обойти общий бюджет 100/2 МиБ.
   */
  putOutbox(item: OperationIntent) {
    const work = this.outboxWork.then(async () => {
      this.gate();

      if (!validIntent(item)) {
        throw new Error('bad_operation');
      }

      const previous = this.outbox.find((entry) => entry.idempotencyKey === item.idempotencyKey);

      if (previous) {
        if (
          previous.path !== item.path ||
          previous.body !== item.body ||
          previous.createdAt !== item.createdAt
        ) {
          throw new Error('idempotency_conflict');
        }

        return;
      }

      const next = [...this.outbox, structuredClone(item)];
      const body = JSON.stringify(next);

      if (next.length > 100 || Buffer.byteLength(body) > 2 * 1024 * 1024) {
        throw new Error('outbox_full');
      }

      await this.persist('outbox.json', body);
      this.outbox = next;
    });

    this.outboxWork = work.catch(() => {});

    return work;
  }

  getOutbox() {
    this.gate();

    return { items: structuredClone(this.outbox) };
  }

  async removeOutbox(key: string) {
    const work = this.outboxWork.then(async () => {
      this.gate();

      const next = this.outbox.filter((item) => item.idempotencyKey !== key);

      await this.persist('outbox.json', JSON.stringify(next));
      this.outbox = next;
    });

    this.outboxWork = work.catch(() => {});
    await work;
  }

  /**
   * Один цикл SSE принадлежит эмулятору; JS не управляет Backoff или watchdog.
   * Clock/foreground gate завершает reconnect до появления следующего поколения.
   */
  startEvents() {
    this.gate();
    this.eventsWanted = true;

    if (!this.eventsWork) {
      const work = this.eventLoop().finally(() => {
        if (this.eventsWork === work) {
          this.eventsWork = null;

          if (this.eventsWanted && this.getState().unlocked) {
            this.startEvents();
          }
        }
      });

      this.eventsWork = work;
    }
  }

  /**
   * Новая dev-вкладка или перезагрузка страницы подписывается на уже открытый поток.
   * Ей отдаётся ready этого соединения: иначе экран считает связь потерянной и не сверяется.
   */
  liveReady() {
    const ready = this.liveReadyEvent;

    return ready && ready.generation === this.state.generation && this.state.unlocked
      ? structuredClone(ready)
      : null;
  }

  /**
   * Остановка отменяет watchdog, reconnect timer и текущий SSE socket.
   * REST вызовы остаются под отдельным generation gate до общего lock.
   */
  stopEvents() {
    this.eventsWanted = false;
    this.liveReadyEvent = null;

    if (this.watchdog) {
      clearInterval(this.watchdog);
    }

    this.watchdog = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = null;
    this.reconnectResolve?.();
    this.reconnectResolve = null;
    this.calls.forEach((call) => {
      if (call.path.endsWith('/events')) {
        call.destroy();
      }
    });
  }

  /**
   * Сердцебиение обновляет monotonic lastActivity; тихий SSE разрывается через 45 секунд.
   * Ошибка pin/auth/schema прекращает автоповтор до нового действия человека.
   */
  private async eventLoop() {
    const generation = this.state.generation;
    let attempt = 0;

    while (this.eventsWanted && generation === this.state.generation) {
      try {
        this.gate(generation);
        await this.eventConnection(generation);
        attempt = 0;
      } catch (error) {
        const code = error instanceof Error ? error.message : 'network';

        if (/pin|locked|revoked|contract|device_unknown/.test(code)) {
          if (code.includes('revoked')) {
            this.state.revoked = true;
          }

          this.lock();
          this.emit('linkState', {
            state: code.includes('pin')
              ? 'pin_mismatch'
              : code.includes('revoked')
                ? 'revoked'
                : code,
            generation: this.state.generation,
            unlocked: false,
          });
          this.eventsWanted = false;

          return;
        }
      }

      if (!this.eventsWanted || generation !== this.state.generation) {
        return;
      }

      this.emit('linkState', {
        state: 'offline',
        generation,
      });

      const milliseconds = Math.min(30000, 1000 * 2 ** attempt++) * (0.8 + Math.random() * 0.4);

      await new Promise<void>((resolve) => {
        this.reconnectResolve = resolve;
        this.reconnectTimer = setTimeout(resolve, milliseconds);
      });
    }
  }

  /**
   * Одна SSE сессия передаёт только bounded frames и обновляет monotonic watchdog.
   * Любое закрытие освобождает отдельный HTTPS agent до следующего connect.
   */
  private eventConnection(generation: number) {
    return new Promise<void>(async (resolve, reject) => {
      let socket;

      try {
        socket = await this.connect(generation);
      } catch (error) {
        reject(error);

        return;
      }

      const agent = new https.Agent();

      agent.createConnection = () => socket;

      const call = https.get(
        {
          host: '127.0.0.1',
          path: PREFIX + 'events',
          agent,
        },
        (response) => {
          if (response.statusCode !== 200) {
            call.destroy(
              new Error(response.statusCode === 403 ? 'device_revoked' : 'device_unknown'),
            );

            return;
          }

          this.lastActivity = this.monotonic();
          this.watchdog = setInterval(() => {
            try {
              this.gate(generation);

              if (this.monotonic() - this.lastActivity > 45000) {
                call.destroy(new Error('watchdog'));
              }
            } catch {
              call.destroy(new Error('locked'));
            }
          }, 1000);
          this.watchdog.unref();

          let buffer = '';

          response.on('data', (part) => {
            this.lastActivity = this.monotonic();
            buffer += part.toString('utf8');

            if (buffer.length > 65536) {
              call.destroy(new Error('contract'));

              return;
            }

            let position;

            while ((position = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, position);

              buffer = buffer.slice(position + 2);

              const name = frame
                .split('\n')
                .find((line) => line.startsWith('event:'))
                ?.slice(6)
                .trim();
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n');

              try {
                this.gate(generation);

                if (!name || (name === 'ready' && JSON.parse(data).api !== 1)) {
                  throw new Error('contract');
                }

                if (name === 'ready') {
                  this.liveReadyEvent = {
                    name,
                    data,
                    generation,
                  };
                }

                this.emit('linkEvent', {
                  name,
                  data,
                  generation,
                });
              } catch {
                call.destroy(new Error('contract'));
              }
            }
          });
          response.once('end', resolve);
          response.once('error', reject);
        },
      );

      this.calls.add(call);
      call.once('error', reject);
      call.once('close', () => {
        this.calls.delete(call);
        agent.destroy();

        if (this.watchdog) {
          clearInterval(this.watchdog);
        }

        this.watchdog = null;
        this.liveReadyEvent = null;
        resolve();
      });
    });
  }

  /**
   * Media использует отдельный лимит двух загрузок и проверяет generation до публикации файла.
   * Повторный 304 разрешён только при существующем собственном кэше этой unlock сессии.
   */
  async fetchMedia(
    chatId: string,
    ref: string,
  ): Promise<{
    file?: string;
    error?: string;
  }> {
    this.gate();

    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(chatId) ||
      !/^(u:[A-Za-z0-9_.-]{1,200}|w:[A-Za-z0-9_-]{1,2731})$/.test(ref) ||
      this.mediaActive >= 2
    ) {
      return { error: 'media_busy' };
    }

    this.mediaActive += 1;

    const generation = this.state.generation;
    const directory = path.join(this.directory, 'media');
    const name = createHash('sha256')
      .update(JSON.stringify([this.qr!.brain.fp, this.state.deviceId, chatId, ref]))
      .digest('hex');
    const file = path.join(directory, name);
    const temporary = file + '.' + generation + '.' + randomBytes(8).toString('hex') + '.tmp';

    try {
      await this.cleanup;
      this.gate(generation);
      await mkdir(directory, {
        recursive: true,
        mode: 0o700,
      });

      const etag = await readFile(file + '.etag', 'utf8').catch(() => '');
      const cached = await readFile(file).catch(() => null);
      const response = await this.binary(
        PREFIX + 'chats/' + chatId + '/media/' + encodeURIComponent(ref),
        cached ? etag : '',
        10000000,
      );

      this.gate(generation);

      if (response.status === 304 && cached) {
        return { file: name };
      }
      if (response.status !== 200) {
        return { error: JSON.parse(response.bytes.toString()).error || 'network' };
      }

      rasterSize(response.bytes, String(response.headers['content-type']).split(';')[0]!);

      const publication = this.cleanup.then(async () => {
        this.gate(generation);
        await writeFile(temporary, response.bytes, { mode: 0o600 });
        this.gate(generation);
        await rename(temporary, file);
        this.gate(generation);
        await writeFile(file + '.etag', String(response.headers.etag || ''), { mode: 0o600 });
        await evictMedia(directory);
        this.gate(generation);
      });

      this.cleanup = publication.catch(() => {});
      await publication;

      return { file: name };
    } catch (error) {
      await rm(temporary, { force: true });

      return {
        error: error instanceof Error && error.message === 'media_type' ? 'media_type' : 'network',
      };
    } finally {
      this.mediaActive -= 1;
    }
  }

  /**
   * Dev update скачивает тот же bounded APK и проверяет metadata/hash, не запуская установщик ОС.
   * Файл существует только в собственном тестовом каталоге и удаляется на lock вместе с media.
   */
  async downloadUpdate() {
    this.gate();

    const generation = this.state.generation;
    const response = await this.request({
      method: 'GET',
      path: PREFIX + 'app',
    });

    if (response.status !== 200) {
      throw new Error('apk_unavailable');
    }

    const metadata = decodeContract<AppUpdate>('app', JSON.parse(response.body));
    const apk = await this.binary(PREFIX + 'app/apk', '', 268435456);

    this.gate(generation);

    if (
      apk.status !== 200 ||
      apk.bytes.length !== metadata.size ||
      createHash('sha256').update(apk.bytes).digest('hex') !== metadata.sha256
    ) {
      throw new Error('apk_mismatch');
    }

    const publication = this.cleanup.then(async () => {
      this.gate(generation);

      const directory = path.join(this.directory, 'updates');

      await mkdir(directory, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path.join(directory, 'cockpit-mobile.apk.tmp'), apk.bytes, { mode: 0o600 });
      this.gate(generation);
      await rename(
        path.join(directory, 'cockpit-mobile.apk.tmp'),
        path.join(directory, 'cockpit-mobile.apk'),
      );
      this.gate(generation);
    });

    this.cleanup = publication.catch(() => {});
    await publication;
  }

  /**
   * Двоичные ручки недоступны request allowlist и ограничены в ходе чтения.
   * Redirect и oversized response не публикуют файл и не создают второе сетевое назначение.
   */
  private async binary(route: string, etag: string, limit: number) {
    const generation = this.state.generation;
    const socket = await this.connect(generation);
    const agent = new https.Agent();

    agent.createConnection = () => socket;

    return new Promise<{
      status: number;
      bytes: Buffer;
      headers: IncomingHttpHeaders;
    }>((resolve, reject) => {
      const call = https.get(
        {
          host: '127.0.0.1',
          path: route,
          agent,
          headers: etag ? { 'if-none-match': etag } : {},
        },
        (response) => {
          const parts: Buffer[] = [];
          let size = 0;

          response.on('data', (part: Buffer) => {
            size += part.length;

            if (size > limit) {
              call.destroy(new Error('media_type'));
            } else {
              parts.push(part);
            }
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              this.gate(generation);
              resolve({
                status: response.statusCode || 0,
                bytes: Buffer.concat(parts),
                headers: response.headers,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );

      this.calls.add(call);
      call.once('error', reject);
      call.once('close', () => {
        this.calls.delete(call);
        agent.destroy();
      });
      call.setTimeout(120000, () => call.destroy(new Error('network')));
    });
  }

  /**
   * Атомарное переименование публикует файл только после fsync его содержимого.
   * Ключи и outbox остаются в приватном временном каталоге тестового телефона.
   */
  private async persist(name: string, body: string) {
    await mkdir(this.directory, {
      recursive: true,
      mode: 0o700,
    });

    const temporary = path.join(this.directory, name + '.tmp');
    const handle = await open(temporary, 'w', 0o600);

    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporary, path.join(this.directory, name));
  }

  /**
   * Закрытие отзывает транспорт и дожидается durable записи и удаления media.
   * Личность и outbox сохраняются для следующего запуска приложения.
   */
  async close() {
    this.lock();
    await this.outboxWork;
    await this.cleanup;
  }

  /**
   * Reset сперва закрывает сеть, затем ждёт завершения durable записи.
   * Синтетические ключи, media и intents удаляются только из каталога этого телефона.
   */
  async resetDevice() {
    this.lock();
    await this.outboxWork;
    await this.cleanup;
    await rm(this.directory, {
      recursive: true,
      force: true,
    });
    this.qr = null;
    this.relays.clear();
    this.key = '';
    this.cert = '';
    this.outbox = [];
    this.state = {
      ...this.state,
      paired: false,
      revoked: false,
      brainName: '',
      deviceId: undefined,
      relays: [],
      activeRelayId: null,
    };
    this.emit('linkState', this.state);
  }
}

/**
 * HTTP обёртка слушает только IPv4 loopback и требует случайный токен каждого вызова.
 * Ошибки возвращают фиксированные коды, не раскрывая QR, сертификаты или тело команды.
 */
export async function startEmulator(phone: PhoneEmulator) {
  const token = randomBytes(32).toString('base64url');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const received = String(
      request.headers['x-emulator-token'] || url.searchParams.get('token') || '',
    );
    const valid =
      /^[A-Za-z0-9_-]{43}$/.test(received) &&
      timingSafeEqual(Buffer.from(received), Buffer.from(token));

    if (!valid) {
      response
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end('{"error":"unauthorized"}');

      return;
    }

    const route = url.pathname;

    if (route === '/link/events' && request.method === 'GET') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
      });

      const unsubscribe = phone.subscribe((name, value) => {
        if (!response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)) {
          response.destroy();
        }
      });

      response.once('close', unsubscribe);

      try {
        phone.startEvents();

        const ready = phone.liveReady();

        if (ready) {
          response.write(`event: linkEvent\ndata: ${JSON.stringify(ready)}\n\n`);
        }
      } catch {
        response.end();
      }

      return;
    }

    try {
      let body = '';

      for await (const part of request) {
        body += part.toString('utf8');

        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
          throw new Error('bad_body');
        }
      }

      const value = body ? JSON.parse(body) : {};
      let result: unknown;

      if (route === '/link/state' && request.method === 'GET') {
        result = phone.getState();
      } else if (route === '/link/request' && request.method === 'POST') {
        try {
          result = await phone.request(value);
        } catch (error) {
          const code = transportCode(error);

          if (code === 'bad_route') {
            throw error;
          }

          result = {
            status: 0,
            body: JSON.stringify({ error: code }),
            generation: phone.getState().generation,
          };
        }
      } else if (route === '/link/add' && request.method === 'POST') {
        await phone.addFromText(value.text);
      } else if (route === '/link/unlock' && request.method === 'POST') {
        phone.unlock();
      } else if (route === '/link/select' && request.method === 'POST') {
        await phone.selectRelay(value.id);
      } else if (route === '/link/remove' && request.method === 'POST') {
        await phone.removeRelay(value.id);
      } else if (route === '/link/media' && request.method === 'POST') {
        result = await phone.fetchMedia(value.chatId, value.ref);
      } else if (route === '/link/update' && request.method === 'POST') {
        await phone.downloadUpdate();
      } else if (/^\/link\/media\/[a-f0-9]{64}$/.test(route) && request.method === 'GET') {
        if (!phone.getState().unlocked) {
          throw new Error('locked');
        }

        const generation = phone.getState().generation;
        const file = path.join(phone.directory, 'media', route.split('/').at(-1)!);
        const bytes = await readFile(file);
        const current = phone.getState();

        if (!current.unlocked || current.generation !== generation) {
          throw new Error('locked');
        }

        const mime = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].find((type) => {
          try {
            rasterSize(bytes, type);

            return true;
          } catch {
            return false;
          }
        });

        if (!mime) {
          throw new Error('media_type');
        }

        response
          .writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
          })
          .end(bytes);

        return;
      } else if (route === '/link/reset' && request.method === 'POST') {
        await phone.resetDevice();
      } else if (route === '/link/outbox') {
        if (request.method === 'POST') {
          await phone.putOutbox(value.item);
        } else if (request.method === 'GET') {
          result = phone.getOutbox();
        } else {
          throw new Error('bad_route');
        }
      } else if (route === '/link/outbox-remove' && request.method === 'POST') {
        await phone.removeOutbox(value.idempotencyKey);
      } else {
        throw new Error('bad_route');
      }

      response
        .writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        .end(JSON.stringify(result ?? {}));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'emulator_error';

      response
        .writeHead(code === 'bad_route' ? 400 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: /^[a-z_]+$/.test(code) ? code : 'emulator_error' }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    token,
    port: (server.address() as { port: number }).port,
    close: async () => {
      phone.lock();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
