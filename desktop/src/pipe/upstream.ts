import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ApiVersion, ConnectionStatus } from '../../../shared/client/clientShell.ts';
import { API_VERSION } from '../../../shared/client/apiVersion.ts';
import { versionFailure } from './versionGate.ts';
import { json } from './pipeServer.ts';

export interface UpstreamOptions {
  address: string;
  fp?: string;
  identity?: { key: string; cert: string };
  windowKey?: () => Promise<string>;
  appApi?: ApiVersion;
  onState?: (state: UpstreamState) => void;
}

export interface UpstreamState {
  status: ConnectionStatus;
  detail: {
    code: string;
    message?: string;
    retryAt?: number;
  } | null;
  serverApi: ApiVersion | null;
}

const FORBIDDEN = new Set([
  'cookie', 'host', 'origin', 'x-grigdesk-token', 'x-grigdesk-internal', 'x-grigdesk-window-key',
  'forwarded', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
]);

/**
 * Cookie и привилегированные заголовки renderer никогда не пересекают трубу.
 * Host и разрешённый Origin заново строятся из проверенного адреса профиля.
 */
function upstreamHeaders(req: IncomingMessage, address: URL, cookie: string, upgrade = false) {
  const headers: IncomingHttpHeaders = {};

  for (const [name, value] of Object.entries(req.headers)) {
    if (!FORBIDDEN.has(name) && !name.startsWith('x-forwarded-')) {
      headers[name] = value;
    }
  }

  headers.host = address.host;

  if (req.headers.origin) {
    headers.origin = address.origin;
  }

  if (cookie) {
    headers.cookie = cookie;
  }

  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }

  return headers;
}

/**
 * HTTP получает TLS-сокет только после проверки полного сертификата по pin.
 * Агент не хранит TLS-сессии; несовпадение не отправляет прикладных байтов.
 */
export function pinnedAgent(options: UpstreamOptions): https.Agent {
  const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 0 });
  const pending = new Set<tls.TLSSocket>();
  const destroy = agent.destroy.bind(agent);
  let closed = false;

  agent.destroy = () => {
    closed = true;

    for (const socket of pending) {
      socket.destroy();
    }

    destroy();
  };

  agent.createConnection = (connection, callback) => {
    if (closed) {
      callback?.(new Error('disconnected'), undefined!);

      return undefined;
    }

    const socket = tls.connect({
      host: new URL(options.address).hostname,
      port: Number(new URL(options.address).port || 443),
      key: options.identity?.key,
      cert: options.identity?.cert,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    });

    pending.add(socket);
    socket.once('close', () => pending.delete(socket));

    let finished = false;
    const finish = (error: Error | null) => {
      if (finished) {
        return;
      }

      finished = true;
      callback?.(error, socket);
    };

    const deadline = setTimeout(() => socket.destroy(new Error('timeout')), 3000);

    socket.once('secureConnect', () => clearTimeout(deadline));
    socket.once('close', () => clearTimeout(deadline));
    socket.once('error', finish);
    socket.once('close', () => finish(new Error('disconnected')));
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw;
      const fp = raw && createHash('sha256').update(raw).digest('hex');

      if (fp !== options.fp) {
        const error = new Error('identityMismatch');

        finish(error);
        socket.destroy();
      } else {
        finish(null);
      }
    });

    return undefined;
  };

  return agent;
}

/**
 * Один профиль владеет сессией местной машины и защёлкой несовместимой версии.
 * Потоки передаются без буферизации; после 401 повтор допустим только GET и HEAD.
 */
export function createUpstream(options: UpstreamOptions) {
  const address = new URL(options.address);
  const remote = address.protocol === 'https:';
  const transport = remote ? https : http;
  const agent = remote ? pinnedAgent(options) : new http.Agent({ keepAlive: true });
  const streams = new Set<Duplex>();
  let cookie = '';
  let exchanging: Promise<void> | null = null;
  let blocked = false;
  let closed = false;
  let connected = false;
  let probeFailures = 0;
  let terminalStatus: number | null = null;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let current: UpstreamState = {
    status: 'connecting',
    detail: null,
    serverApi: null,
  };

  /**
   * Запросы и probe разделяют один учёт живого сокета, даже при его повторной выдаче агентом.
   * Единственный обработчик закрытия удаляет сокет из набора без накопления на keep-alive.
   */
  const trackStream = (socket: Duplex) => {
    if (streams.has(socket)) {
      return;
    }

    streams.add(socket);
    socket.once('close', () => streams.delete(socket));
  };

  /**
   * Закрываются и HTTP-потоки, и обе стороны upgrade, кроме ответа с причиной отказа.
   * Его сокет освобождает вызывающий код после отправки диагностики renderer.
   */
  const closeTraffic = (except?: Duplex | null) => {
    for (const socket of streams) {
      if (socket !== except) {
        socket.destroy();
      }
    }
  };

  /**
   * Терминальное состояние не отменяется поздним ответом параллельного запроса.
   * Новое явное подключение создаёт отдельный экземпляр транспорта.
   */
  const setState = (status: ConnectionStatus, code?: string, except?: Duplex | null) => {
    if (closed || ((blocked || terminalStatus) && status !== current.status)) {
      return;
    }

    if (['revoked', 'unpaired', 'identityMismatch'].includes(status)) {
      terminalStatus = status === 'revoked' ? 403 : status === 'unpaired' ? 401 : 503;
      closeTraffic(except);
    }

    clearTimeout(healthTimer);
    healthTimer = undefined;

    if (status === 'online') {
      healthTimer = setTimeout(() => {
        healthTimer = undefined;
        void probe();
      }, 5000);
      healthTimer.unref();
    }

    current = {
      ...current,
      status,
      detail: code ? { code } : null,
    };
    options.onState?.(current);
  };
  /**
   * Защёлка несовместимости запрещает дальнейшие запросы до нового подключения.
   * Версия сервера сохраняется для понятного сообщения в интерфейсе.
   */
  const checkVersion = (response: IncomingMessage) => {
    if (blocked) {
      return current.detail?.code || 'server_upgrade_required';
    }

    const header = response.headers['x-grigdesk-api'];
    const failure = versionFailure(options.appApi || API_VERSION, header, response.statusCode);

    if (typeof header === 'string' && /^\d+\.\d+$/.test(header)) {
      const [major, minor] = header.split('.').map(Number);

      current.serverApi = { major: major!, minor: minor! };
    }

    if (failure) {
      setState('incompatible', failure);
      blocked = true;
      closeTraffic(response.socket);
    }

    return failure;
  };
  /**
   * Параллельные запросы делят один обмен локального ключа на сессию.
   * Cookie хранится только в замыкании main и обновляется после 401.
   */
  const exchange = async () => {
    if (closed) {
      throw new Error('disconnected');
    }

    if (remote || cookie) {
      return;
    }

    if (!exchanging) {
      exchanging = (async () => {
        const key = await options.windowKey?.();

        if (closed) {
          throw new Error('disconnected');
        }

        if (!key) {
          throw new Error('window_key_missing');
        }

        await new Promise<void>((resolve, reject) => {
          const request = http.request(new URL('/api/auth/window-session', address), {
            method: 'POST',
            agent,
            headers: { 'x-grigdesk-window-key': key },
          }, (response) => {
            const failure = checkVersion(response);
            const value = response.headers['set-cookie']?.find((item) => item.startsWith('grigdesk_sid='));

            response.resume();
            response.once('end', () => {
              if (failure || response.statusCode !== 200 || !value) {
                reject(new Error(failure || 'window_key_rejected'));
              } else {
                cookie = value.split(';')[0]!;
                resolve();
              }
            });
          });

          const deadline = setTimeout(() => request.destroy(new Error('timeout')), 3000);

          request.once('close', () => clearTimeout(deadline));
          request.on('error', reject);
          request.end();
        });
      })().finally(() => {
        exchanging = null;
      });
    }

    await exchanging;
  };
  /**
   * После успешного входа один медленный hello не отменяет действующий транспорт.
   * Только три последовательных отказа допускают offline и создание нового поколения.
   */
  const probeFailed = () => {
    probeFailures += 1;
    setState(connected && probeFailures < 3 ? 'online' : 'offline');
  };

  /**
   * Ошибка одного запроса возвращается только его получателю, не закрывая соседние потоки.
   * Состояние меняет лишь probe либо явный отказ pin; несовместимость остаётся защёлкнутой.
   */
  const fail = (error: Error, res?: ServerResponse, probing = false) => {
    if (!blocked && error.message === 'identityMismatch') {
      setState('identityMismatch');
    } else if (!blocked && probing) {
      probeFailed();
    }

    if (res?.writableEnded) {
      return;
    }

    if (res && !res.headersSent) {
      json(res, blocked ? 426 : 503, {
        error: closed ? 'disconnected' : current.detail?.code || current.status,
      });
    } else {
      res?.destroy();
    }
  };

  /**
   * Короткий JSON отказа читается до классификации устройства, без записи в журнал.
   * Большое тело возвращает ограниченный префикс и продолжает обычный streaming.
   */
  const errorBody = async (incoming: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.from(chunk);

      chunks.push(bytes);
      size += bytes.length;

      if (size > 65536) {
        return { data: Buffer.concat(chunks), complete: false };
      }
    }

    return { data: Buffer.concat(chunks), complete: true };
  };

  /**
   * Только явный код отзыва или отсутствия привязки прекращает работу устройства.
   * Обычный запрет прикладного API не меняет привязку и не запрещает другие действия.
   */
  const authState = (status: number | undefined, body: Buffer): ConnectionStatus | null => {
    let code: unknown;

    try {
      code = JSON.parse(body.toString()).error;
    } catch {
      return null;
    }

    if (status === 403 && code === 'device_revoked') {
      return 'revoked';
    }

    return status === 401 && ['unpaired', 'device_unknown'].includes(String(code)) ? 'unpaired' : null;
  };

  /**
   * Заголовки и тело передаются одинаково для обычного ответа и прочитанного JSON-отказа.
   * Cookie сервера остаётся внутри трубы, а большой ответ продолжает идти потоком.
   */
  const forwardResponse = (incoming: IncomingMessage, res: ServerResponse,
    body?: { data: Buffer; complete: boolean }) => {
    if (blocked) {
      json(res, 426, { error: current.detail?.code });
      incoming.destroy();

      return;
    }

    if (terminalStatus && incoming.statusCode !== terminalStatus) {
      json(res, terminalStatus, { error: current.detail?.code || current.status });
      incoming.destroy();

      return;
    }

    const headers = { ...incoming.headers };

    delete headers['set-cookie'];
    res.writeHead(incoming.statusCode || 502, headers);

    if (body?.data.length) {
      res.write(body.data);
    }

    if (body?.complete) {
      res.end();
    } else {
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
      res.once('close', () => incoming.destroy());
    }
  };

  /**
   * После потери сессии один обмен разделяется параллельными запросами.
   * Поздний отказ старой cookie не стирает новую; повторяются только чтения, мутации получают отказ.
   */
  const refreshSession = (req: IncomingMessage, res: ServerResponse, rejectedCookie: string) => {
    if (cookie === rejectedCookie) {
      cookie = '';
    }

    void exchange().then(() => {
      if (['GET', 'HEAD'].includes(req.method || '')) {
        void request(req, res, true);
      } else {
        json(res, 401, { error: 'session_expired' });
      }
    }).catch((error: Error) => fail(error, res));
  };

  /**
   * Версию и auth-статус проверяем до тела, а сессию держим только в main.
   * Уже начатый POST не повторяется даже после успешного обновления сессии.
   */
  const request = async (req: IncomingMessage, res: ServerResponse, retried = false): Promise<void> => {
    if (closed || blocked || terminalStatus) {
      json(res, closed ? 503 : blocked ? 426 : terminalStatus!, {
        error: closed ? 'disconnected' : current.detail?.code || current.status,
      });

      return;
    }

    try {
      await exchange();
    } catch (error) {
      fail(error as Error, res);

      return;
    }

    if (closed) {
      json(res, 503, { error: 'disconnected' });

      return;
    }

    const sentCookie = cookie;
    const outgoing = transport.request(new URL(req.url || '/', address), {
      method: req.method,
      agent,
      headers: upstreamHeaders(req, address, sentCookie),
    }, (incoming) => {
      outgoing.setTimeout(0);

      if (checkVersion(incoming)) {
        json(res, 426, { error: current.detail?.code });
        incoming.destroy();

        return;
      }

      if (!remote && incoming.statusCode === 401 && !retried) {
        incoming.resume();
        refreshSession(req, res, sentCookie);

        return;
      }

      if (!remote && incoming.statusCode === 200 && !retried && req.method === 'GET'
        && new URL(req.url || '/', address).pathname === '/api/auth/state') {
        void errorBody(incoming).then((body) => {
          let authenticated: unknown;

          try {
            authenticated = body.complete ? JSON.parse(body.data.toString()).authenticated : undefined;
          } catch {
            // Неверный ответ остаётся ответом API и не становится разрешением доступа.
          }

          if (authenticated === false) {
            refreshSession(req, res, sentCookie);
          } else {
            forwardResponse(incoming, res, body);
          }
        }).catch((error: Error) => fail(error, res));

        return;
      }

      if (remote && [401, 403].includes(incoming.statusCode || 0)) {
        void errorBody(incoming).then((body) => {
          const status = body.complete ? authState(incoming.statusCode, body.data) : null;

          if (status) {
            setState(status, undefined, incoming.socket);
          }

          forwardResponse(incoming, res, body);
        }).catch((error: Error) => fail(error, res));
      } else {
        forwardResponse(incoming, res);
      }
    });

    outgoing.on('socket', trackStream);
    outgoing.on('error', (error) => fail(error, res));
    outgoing.once('socket', (socket) => {
      if (socket.connecting) {
        const deadline = setTimeout(() => outgoing.destroy(new Error('timeout')), 3000);

        socket.once('connect', () => clearTimeout(deadline));
        socket.once('close', () => clearTimeout(deadline));
      }
    });
    res.once('close', () => outgoing.destroy());

    if (retried) {
      outgoing.end();
    } else {
      req.pipe(outgoing);
    }
  };

  /**
   * Upgrade использует тот же агент, поэтому pin проверен до HTTP-заголовков.
   * После 101 двунаправленный поток сохраняет бинарные кадры без перекодировки.
   */
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed || blocked || terminalStatus) {
      const status = closed ? 503 : blocked ? 426 : terminalStatus;

      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);

      return;
    }

    void exchange().then(() => {
      if (closed) {
        socket.destroy();

        return;
      }

      const outgoing = transport.request(new URL(req.url || '/', address), {
        method: 'GET',
        agent,
        headers: upstreamHeaders(req, address, cookie, true),
      });

      outgoing.on('upgrade', (incoming, target, targetHead) => {
        const lines = Object.entries(incoming.headers)
          .filter(([key]) => key !== 'set-cookie')
          .map(([key, value]) => `${key}: ${value}`);

        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);

        if (targetHead.length) {
          socket.write(targetHead);
        }

        if (head.length) {
          target.write(head);
        }

        streams.add(target);
        streams.add(socket);
        target.once('close', () => {
          streams.delete(target);
          socket.destroy();
        });
        socket.once('close', () => {
          streams.delete(socket);
          target.destroy();
        });
        target.on('error', () => socket.destroy());
        socket.on('error', () => target.destroy());
        target.pipe(socket).pipe(target);
      });
      outgoing.on('response', (incoming) => {
        checkVersion(incoming);
        incoming.resume();
        socket.end(`HTTP/1.1 ${blocked ? 426 : incoming.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      });
      outgoing.on('error', (error) => {
        fail(error);
        socket.destroy();
      });
      outgoing.end();
    }).catch((error: Error) => {
      fail(error);
      socket.destroy();
    });
  };

  /**
   * Первая попытка ограничена тремя секундами и использует обычный auth и version gate.
   * Тело hello нужно только для состояния, поток прикладного SSE не занимает этот запрос.
   */
  const probe = async (retried = false): Promise<void> => {
    if (closed || blocked || terminalStatus) {
      return;
    }

    try {
      await exchange();

      if (closed) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const sentCookie = cookie;
        const outgoing = transport.request(new URL('/api/client/hello', address), {
          agent,
          headers: sentCookie ? { cookie: sentCookie } : {},
        }, (incoming) => {
          const failure = checkVersion(incoming);

          if (failure) {
            incoming.destroy();
            resolve();

            return;
          }

          if (!remote && incoming.statusCode === 401 && !retried) {
            if (cookie === sentCookie) {
              cookie = '';
            }

            incoming.resume();
            void probe(true).then(resolve, reject);

            return;
          }

          if (remote && [401, 403].includes(incoming.statusCode || 0)) {
            void errorBody(incoming).then((body) => {
              const status = body.complete ? authState(incoming.statusCode, body.data) : null;

              if (status) {
                setState(status, undefined, incoming.socket);
              } else {
                probeFailed();
              }

              incoming.destroy();
              resolve();
            }).catch(reject);
          } else {
            incoming.resume();
            incoming.once('end', () => {
              if (incoming.statusCode === 200) {
                connected = true;
                probeFailures = 0;
                setState('online');
              } else {
                probeFailed();
              }

              resolve();
            });
          }

          incoming.on('error', reject);
        });
        const deadline = setTimeout(() => outgoing.destroy(new Error('timeout')), 3000);

        outgoing.once('close', () => clearTimeout(deadline));
        outgoing.on('socket', trackStream);
        outgoing.on('error', reject);
        outgoing.end();
      });
    } catch (error) {
      fail(error as Error, undefined, true);
    }
  };

  return {
    request,
    upgrade,
    probe,
    state: () => current,
    setState,
    /**
     * Закрытие отменяет и ожидающие TLS-handshake, и уже передаваемые потоки.
     * Позднее чтение ключа не может вновь начать HTTP закрытого транспорта.
     */
    close() {
      closed = true;
      clearTimeout(healthTimer);
      agent.destroy();

      for (const socket of streams) {
        socket.destroy();
      }

      streams.clear();
    },
  };
}
