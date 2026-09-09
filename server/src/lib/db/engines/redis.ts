import Redis from 'ioredis';

type Payload = Record<string, unknown>;

// Клиент Redis, как его видит адаптер. Служебное соединение нужно только затянувшемуся
// скрипту: снять его по занятому сокету нечем.
interface RedisClient {
  call: (...args: unknown[]) => Promise<unknown>;
  scan: (cursor: number, ...args: unknown[]) => Promise<unknown>;
  quit?: () => Promise<unknown>;
}

interface RedisHandle {
  client: RedisClient;
  control: RedisClient | null;
  readOnlyActive: boolean;
  commandInfo?: (command: string) => Promise<unknown>;
  close?: () => Promise<void>;
}

// Описание команды из COMMAND INFO: по нему видно, пишет ли она и где её ключи.
interface CommandInfo {
  flags: unknown[];
  firstKey: number;
  lastKey: number;
  step: number;
}

function tokensOf(text: unknown): string[] {
  const match = String(text || '').trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) || [];
  return match.map((token) => token.replace(/^(?:"|')|(?:"|')$/gu, ''));
}

// Ответ приходит и массивом позиций, и объектом с именами — зависит от версии
// сервера и клиента. Обе формы законны, и разбирать их надо одинаково.
function commandInfoOf(value: unknown): CommandInfo | null {
  const info = (Array.isArray(value) ? value[0] : value) as Payload | unknown[] | null;

  if (!info) return null;
  if (!Array.isArray(info) && typeof info !== 'object') return null;

  const named = info as Payload;
  const positional = info as unknown[];

  return {
    flags: Array.isArray(named.flags)
      ? named.flags as unknown[]
      : (positional[2] as unknown[] || []),
    firstKey: Number(named.firstKey ?? named.first_key ?? positional[3]),
    lastKey: Number(named.lastKey ?? named.last_key ?? positional[4]),
    step: Number(named.step ?? positional[5]) || 1,
  };
}

function keysOf(tokens: string[], info: CommandInfo | null): string[] {
  if (!info || !Number.isInteger(info.firstKey) || info.firstKey <= 0) return [];

  const last = info.lastKey < 0 ? tokens.length + info.lastKey : info.lastKey;
  const keys: string[] = [];

  for (let index = info.firstKey; index <= last && index < tokens.length; index += info.step) {
    keys.push(String(tokens[index]));
  }

  return keys;
}

/** Закрываются оба соединения сессии: рабочее и служебное для SCRIPT KILL. */
async function closeHandle(handle: RedisHandle | RedisClient | null): Promise<void> {
  const owner = handle as RedisHandle | null;
  const client = owner?.client || handle as RedisClient | null;

  await Promise.allSettled([client?.quit?.(), owner?.control?.quit?.()]);
}

export default {
  id: 'redis',
  label: 'Redis',
  capabilities: { schema: true, readOnly: true, estimate: true, cancel: 'script' },
  async open({
    profile, password, stream, openStream, driver = Redis as unknown as new (
      options: unknown,
    ) => unknown,
  }: {
    profile?: Payload;
    password?: unknown;
    stream?: unknown;
    openStream?: () => Promise<unknown>;
    // Драйвер подменяют в проверке, поэтому здесь он описан как конструктор клиента,
    // а не как конкретный класс ioredis: заглушке незачем повторять его целиком.
    driver?: new (options: unknown) => unknown;
  } = {}): Promise<RedisHandle> {
    const base = {
      host: profile?.host,
      port: Number(profile?.port) || 6379,
      username: profile?.user || undefined,
      password: Buffer.isBuffer(password) ? password.toString('utf8') : String(password || ''),
      db: Number(profile?.database) || 0,
      lazyConnect: false,
      enableOfflineQueue: false,
    };
    const client = new driver({
      ...base,
      ...(stream ? { stream } : {}),
    }) as RedisClient;

    // Служебное соединение нужно только затянувшемуся скрипту: снять его иначе
    // нечем, а пароль для отдельного подключения позже уже недоступен.
    let control: RedisClient | null = null;

    try {
      const controlStream = stream && typeof openStream === 'function'
        ? await openStream()
        : null;

      if (!stream || controlStream) {
        control = new driver({
          ...base,
          ...(controlStream ? { stream: controlStream } : {}),
        }) as RedisClient;
      }
    } catch {
      control = null;
    }

    const handle: RedisHandle = {
      client,
      control,
      readOnlyActive: profile?.role === 'read',
    };

    handle.close = () => closeHandle(handle);

    return handle;
  },
  close: closeHandle,
  async schema(handle: RedisHandle | RedisClient | null) {
    const client = (handle as RedisHandle)?.client || handle as RedisClient;

    return client.scan(0, 'COUNT', 100);
  },
  async analyze(text: unknown, handle?: RedisHandle | RedisClient | null) {
    const tokens = tokensOf(text);

    if (!tokens.length || /[;\n]/u.test(String(text || ''))) {
      return { queryClass: 'unknown', single: false, tables: [], forbidden: [] };
    }

    const owner = handle as RedisHandle | null;
    const command = String(tokens[0]).toUpperCase();
    const client = owner?.client || handle as RedisClient | null;
    const info = typeof owner?.commandInfo === 'function'
      ? await owner.commandInfo(command)
      : await client?.call?.('COMMAND', 'INFO', command);
    const normalized = commandInfoOf(info);
    const flags = normalized?.flags || [];
    const queryClass = flags.map(String).some((flag) => flag.toLowerCase() === 'write')
      ? 'write'
      : (normalized ? 'read' : 'unknown');
    const keys = keysOf(tokens, normalized);
    return {
      queryClass,
      single: true,
      text: String(text || '').trim(),
      command,
      tokens,
      tables: keys.length ? keys : tokens.slice(1, 2),
      forbidden: [],
      tableFunctions: [],
    };
  },
  async inspectRights(handle: RedisHandle | RedisClient | null, profile: Payload = {}) {
    const client = (handle as RedisHandle)?.client || handle as RedisClient;
    const response = await client.call('ACL', 'GETUSER', profile.user || 'default');
    const text = JSON.stringify(response).toLowerCase();
    const writable = /\+@all|\+@write|\+(?:set|del|mset|hset|lpush|sadd)\b/u.test(text);
    return { confirmedReadOnly: !writable && /\+@read|\+get\b/u.test(text), writable };
  },
  async estimate(
    handle: RedisHandle | RedisClient | null,
    analysis: Payload = {},
    limits: Payload = {},
  ) {
    const command = String(analysis.command || '').toUpperCase();
    const tokens = (analysis.tokens as string[]) || tokensOf(analysis.text);
    const timeoutMs = Number(limits.timeoutMs) || 15_000;
    if (analysis.queryClass === 'write') {
      return {
        rows: Math.max(1, (analysis.tables as unknown[] | undefined)?.length || 0),
        bytes: 0,
        timeoutMs,
      };
    }
    if (command === 'GET' && tokens[1]) {
      const client = (handle as RedisHandle)?.client || handle as RedisClient;
      const length = Number(await client.call('STRLEN', tokens[1]));
      return {
        rows: 1,
        bytes: Number.isFinite(length) ? length + 16 : null,
        timeoutMs,
      };
    }
    if (['EXISTS', 'TTL', 'PTTL', 'STRLEN', 'HLEN', 'LLEN', 'SCARD', 'ZCARD', 'TYPE']
      .includes(command)) {
      return { rows: 1, bytes: 64, timeoutMs };
    }
    return {
      rows: null,
      bytes: null,
      timeoutMs,
    };
  },
  async execute(handle: RedisHandle | RedisClient | null, request: Payload = {}) {
    const client = (handle as RedisHandle)?.client || handle as RedisClient;
    const tokens = tokensOf(request.text);
    const result = await client.call(...tokens);

    return Array.isArray(result)
      ? (result as unknown[]).map((value) => ({ value }))
      : [{ value: result }];
  },
  async cancel(handle: RedisHandle | RedisClient | null, run: Payload = {}) {
    const command = String(
      run.command || String(run.text || '').trim().split(/\s+/u)[0] || '',
    ).toUpperCase();
    const killer = ['EVAL', 'EVALSHA'].includes(command)
      ? ['SCRIPT', 'KILL']
      : (['FCALL', 'FCALL_RO'].includes(command) ? ['FUNCTION', 'KILL'] : null);
    const owner = handle as RedisHandle | null;

    if (owner?.control && killer) {
      try {
        await owner.control.call(...killer);
        return { ok: true, method: 'query' };
      } catch {
        // Скрипт мог завершиться сам — это не повод рвать рабочее соединение.
      }
    }
    // Обычная команда Redis атомарна: прерывать уже нечего, а разрыв соединения
    // стоил бы человеку повторного пароля ради выполненного запроса.
    return { ok: false, method: 'wait' };
  },
};
