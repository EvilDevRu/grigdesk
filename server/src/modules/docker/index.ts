// Модуль «Докер»: HTTP-обзор хоста и три потоковых канала — логи, статистика, терминал.
//
// Доступ: общий auth guard закрывает весь /api, а здесь добавлены ещё два условия —
// включённый плагин и СЕССИЯ человека. CLI-токен агента сюда не пускается намеренно:
// панель управления контейнерами хоста — инструмент человека, а агенту для docker
// остаётся обычный Bash с его собственными правилами подтверждения.
import fp from 'fastify-plugin';
import type { FastifyReply } from 'fastify';
import type {} from '@fastify/websocket';
import type { WebSocket } from 'ws';

import { createLogDemuxer } from '../../lib/docker/client.ts';
import type { DockerService } from '../../lib/docker/service.ts';
import type {
  DockerExecInput,
  DockerExecMessage,
  DockerLogFrame,
  DockerLogMessage,
  DockerStatsInput,
  DockerStatsMap,
  DockerStatsMessage,
} from '../../../../shared/dockerContracts.ts';

interface DockerModuleOptions {
  service: DockerService;
}

interface DockerQuery {
  force?: unknown;
  volumes?: unknown;
  id?: unknown;
  tail?: unknown;
  timestamps?: unknown;
  interval?: unknown;
  shell?: unknown;
  cols?: unknown;
  rows?: unknown;
}

interface QueryRoute {
  Querystring: DockerQuery;
}

interface IdRoute extends QueryRoute {
  Params: {
    id: string;
  };
}

interface ContainerActionRoute {
  Params: {
    id: string;
    action: string;
  };
}

interface ProjectActionRoute {
  Params: {
    project: string;
    action: string;
  };
}

interface VolumeRoute extends QueryRoute {
  Params: {
    name: string;
  };
}

type StreamMessage = DockerLogMessage | DockerStatsMessage | DockerExecMessage;

// Потоки живут, пока открыта вкладка, поэтому потолки нужны: без них забытые вкладки
// накапливают каналы к демону, и первым это заметит не кокпит, а сам docker.
const MAX_LOG_STREAMS = 6;
const MAX_EXEC_SESSIONS = 4;
const MAX_STATS_WATCHERS = 4;

// Логи батчатся: строки контейнера идут очередями по сотне, и отдельное сообщение
// WebSocket на каждую строку грузит вкладку сильнее, чем сами логи.
const LOG_FLUSH_MS = 80;
const LOG_BATCH_LIMIT = 64 * 1024;

// Статистика — периодический срез. Чаще секунды её не считает и сам docker stats.
const STATS_MIN_INTERVAL_MS = 1000;
const STATS_MAX_CONTAINERS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : 'Ошибка Docker';
}

/**
 * Ошибки политики сохраняют HTTP-статус и код, а неизвестный отказ получает общий
 * ответ. Непроверенный объект исключения не становится частью контракта маршрута.
 */
function sendError(reply: FastifyReply, error: unknown) {
  const source = isRecord(error) ? error : {};
  const status = Number(source.status) || 500;

  return reply.code(status).send({
    error: typeof source.code === 'string' && source.code ? source.code : 'docker_error',
    ...(typeof source.message === 'string' && source.message ? { message: source.message } : {}),
  });
}

const asBool = (value: unknown) => value === true || value === 'true' || value === '1';

function asNumber(value: unknown): number {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;

  return Number.isFinite(number) ? number : 0;
}

function sendMessage(socket: WebSocket, message: StreamMessage): void {
  socket.send(JSON.stringify(message));
}

/**
 * WebSocket принимает недоверенные байты. JSON сначала остаётся unknown: null,
 * массивы и повреждённые кадры отбрасываются до доступа к полям команды.
 */
function readMessage(raw: unknown): Record<string, unknown> | null {
  let text: string;

  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString('utf8');
  } else if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
    text = Buffer.concat(raw).toString('utf8');
  } else {
    return null;
  }

  try {
    const value: unknown = JSON.parse(text);

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Команды принимают только известные варианты. Некорректные значения не попадают
 * в неявное преобразование объектов к строке и не становятся ID контейнеров.
 */
function readStatsCommand(raw: unknown): DockerStatsInput | null {
  const message = readMessage(raw);

  if (message?.t !== 'watch') {
    return null;
  }

  return {
    t: 'watch',
    ids: (Array.isArray(message.ids) ? message.ids : [])
      .filter((id): id is string => typeof id === 'string' && Boolean(id))
      .slice(0, STATS_MAX_CONTAINERS),
  };
}

/**
 * Ввод требует текст, а resize сохраняет прежний размер при пропущенной или
 * некорректной координате. Числовые строки принимаются для старых клиентов.
 */
function readExecCommand(raw: unknown, cols: number, rows: number): DockerExecInput | null {
  const message = readMessage(raw);

  if (message?.t === 'in' && typeof message.d === 'string') {
    return {
      t: 'in',
      d: message.d,
    };
  }
  if (message?.t === 'resize') {
    return {
      t: 'resize',
      cols: asNumber(message.cols) || cols,
      rows: asNumber(message.rows) || rows,
    };
  }

  return null;
}

export default fp<DockerModuleOptions>(async function dockerModule(fastify, { service }) {
  const counters = {
    logs: 0,
    exec: 0,
    stats: 0,
  };

  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/docker')) {
      return;
    }
    if (!fastify.pluginEnabled('docker')) {
      return reply.code(404).send({ error: 'plugin_disabled' });
    }
    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }
  });

  fastify.get('/api/docker/health', async () => service.health());

  fastify.get('/api/docker/overview', async (request, reply) => {
    try {
      return await service.overview();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<QueryRoute>('/api/docker/usage', async (request, reply) => {
    try {
      return await service.usage({ force: asBool(request.query?.force) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<IdRoute>('/api/docker/containers/:id', async (request, reply) => {
    try {
      return await service.inspect(String(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ContainerActionRoute>('/api/docker/containers/:id/:action', async (request, reply) => {
    try {
      return await service.containerAction(String(request.params.id), String(request.params.action));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<IdRoute>('/api/docker/containers/:id', async (request, reply) => {
    try {
      return await service.removeContainer(String(request.params.id), {
        force: asBool(request.query?.force),
        volumes: asBool(request.query?.volumes),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<ProjectActionRoute>('/api/docker/projects/:project/:action', async (request, reply) => {
    try {
      return await service.projectAction(String(request.params.project), String(request.params.action));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<IdRoute>('/api/docker/images/:id', async (request, reply) => {
    try {
      return await service.removeImage(String(request.params.id), { force: asBool(request.query?.force) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<VolumeRoute>('/api/docker/volumes/:name', async (request, reply) => {
    try {
      return await service.removeVolume(String(request.params.name), { force: asBool(request.query?.force) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.delete<IdRoute>('/api/docker/networks/:id', async (request, reply) => {
    try {
      return await service.removeNetwork(String(request.params.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<{ Body: unknown }>('/api/docker/prune', async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};

    try {
      return await service.prune({
        targets: Array.isArray(body.targets) ? body.targets : [],
        allImages: body.allImages === true,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /**
   * Логи контейнера. Кадры демона разбираются на сервере, а вкладке уходит уже
   * готовый текст с пометкой потока: разбирать бинарный протокол Docker в браузере
   * значило бы держать вторую копию того же знания.
   */
  fastify.get<QueryRoute>('/api/docker/logs', { websocket: true }, async (socket, request) => {
    const id = String(request.query?.id || '');
    if (!id) {
      socket.close(1008, 'container id required');
      return;
    }
    if (counters.logs >= MAX_LOG_STREAMS) {
      socket.close(1013, 'too many log streams');
      return;
    }
    // Подготовка тоже занимает место: параллельные открытия не должны обходить лимит.
    counters.logs += 1;

    let stream: Awaited<ReturnType<DockerService['logStream']>>;
    try {
      stream = await service.logStream(id, {
        tail: asNumber(request.query?.tail) || null,
        timestamps: asBool(request.query?.timestamps),
      });
    } catch (error) {
      counters.logs = Math.max(0, counters.logs - 1);

      try {
        sendMessage(socket, { t: 'error', message: errorMessage(error) });
      } catch { /* закрыт */ }
      socket.close(1011, 'log stream failed');
      return;
    }
    if (socket.readyState !== 1) {
      counters.logs = Math.max(0, counters.logs - 1);
      stream.abort();
      return;
    }

    const demux = createLogDemuxer();
    let pending: DockerLogFrame[] = [];
    let pendingSize = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const flush = () => {
      timer = null;
      if (!pending.length || socket.readyState !== 1) {
        return;
      }
      sendMessage(socket, { t: 'log', lines: pending });
      pending = [];
      pendingSize = 0;
    };
    const push = (frame: DockerLogFrame) => {
      if (pendingSize >= LOG_BATCH_LIMIT) {
        return;
      }
      pending.push(frame);
      pendingSize += frame.text.length;
      if (!timer) {
        timer = setTimeout(flush, LOG_FLUSH_MS);
        timer.unref?.();
      }
    };

    stream.res.on('data', (chunk: Buffer) => {
      // Контейнер с TTY отдаёт сырой поток без служебных кадров — разбирать нечего.
      if (stream.tty) {
        push({ stream: 'stdout', text: chunk.toString('utf8') });
        return;
      }
      for (const frame of demux(chunk)) {
        push(frame);
      }
    });
    stream.res.on('end', () => {
      flush();
      if (socket.readyState === 1) {
        sendMessage(socket, { t: 'end' });
      }
    });
    stream.res.on('error', (error: unknown) => {
      if (socket.readyState === 1) {
        sendMessage(socket, { t: 'error', message: errorMessage(error) });
      }
    });

    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;

      if (timer) {
        clearTimeout(timer);
      }
      counters.logs = Math.max(0, counters.logs - 1);
      stream.abort();
    };
    socket.on('close', stop);
    socket.on('error', stop);
  });

  /**
   * Живая статистика. Опрашивает демон сам сервер и одним сообщением отдаёт срез по
   * всем наблюдаемым контейнерам: вкладка иначе открыла бы по запросу на контейнер,
   * а их тут полусотня.
   */
  fastify.get<QueryRoute>('/api/docker/stats', { websocket: true }, (socket, request) => {
    if (counters.stats >= MAX_STATS_WATCHERS) {
      socket.close(1013, 'too many stats watchers');
      return;
    }
    counters.stats += 1;

    const interval = Math.max(
      STATS_MIN_INTERVAL_MS,
      (asNumber(request.query?.interval) || 3) * 1000,
    );
    let ids: string[] = [];
    let busy = false;
    let stopped = false;

    const tick = async () => {
      if (busy || stopped || !ids.length || socket.readyState !== 1) {
        return;
      }
      busy = true;
      const items: DockerStatsMap = {};
      await Promise.all(ids.map(async (id) => {
        try {
          const value = await service.statsOnce(id);
          if (value) {
            items[id] = value;
          }
        } catch { /* контейнер мог остановиться между срезами — пропускаем */ }
      }));
      busy = false;
      if (stopped || socket.readyState !== 1) {
        return;
      }
      sendMessage(socket, { t: 'stats', at: new Date().toISOString(), items });
    };

    socket.on('message', (raw: unknown) => {
      const message = readStatsCommand(raw);

      if (!message) {
        return;
      }
      ids = message.ids;
      tick();
    });

    const timer = setInterval(tick, interval);
    timer.unref?.();

    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      counters.stats = Math.max(0, counters.stats - 1);
    };
    socket.on('close', stop);
    socket.on('error', stop);
  });

  /**
   * Терминал внутри контейнера. Контракт сообщений тот же, что у раздела «Терминал»:
   * вкладка шлёт JSON (ввод и размер), сервер — сырые байты, чтобы управляющие
   * последовательности доезжали до xterm нетронутыми.
   */
  fastify.get<QueryRoute>('/api/docker/exec', { websocket: true }, async (socket, request) => {
    const id = String(request.query?.id || '');
    if (!id) {
      socket.close(1008, 'container id required');
      return;
    }
    if (counters.exec >= MAX_EXEC_SESSIONS) {
      socket.close(1013, 'too many exec sessions');
      return;
    }
    // Подготовка тоже занимает место: параллельные открытия не должны обходить лимит.
    counters.exec += 1;

    let session: Awaited<ReturnType<DockerService['execStart']>>;
    try {
      session = await service.execStart(id, { shell: String(request.query?.shell || '') });
    } catch (error) {
      counters.exec = Math.max(0, counters.exec - 1);

      try {
        sendMessage(socket, { t: 'error', message: errorMessage(error) });
      } catch { /* закрыт */ }
      socket.close(1011, 'exec failed');
      return;
    }
    if (socket.readyState !== 1) {
      counters.exec = Math.max(0, counters.exec - 1);
      session.close();
      return;
    }
    let stopped = false;

    const cols = asNumber(request.query?.cols) || 100;
    const rows = asNumber(request.query?.rows) || 30;
    session.resize(cols, rows);

    session.socket.on('data', (chunk: Buffer) => {
      if (socket.readyState === 1) {
        socket.send(chunk);
      }
    });
    session.socket.on('close', () => {
      if (socket.readyState === 1) {
        socket.close(1000, 'exec finished');
      }
    });
    session.socket.on('error', () => {
      if (socket.readyState === 1) {
        socket.close(1011, 'exec stream error');
      }
    });

    socket.on('message', (raw: unknown) => {
      const message = readExecCommand(raw, cols, rows);

      if (message?.t === 'in') {
        session.socket.write(message.d);
        return;
      }
      if (message?.t === 'resize') {
        session.resize(message.cols, message.rows);
      }
    });

    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;

      counters.exec = Math.max(0, counters.exec - 1);
      session.close();
    };
    socket.on('close', stop);
    socket.on('error', stop);
  });
}, { name: 'module-docker' });
