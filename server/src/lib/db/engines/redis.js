import Redis from 'ioredis';

function tokensOf(text) {
  const match = String(text || '').trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) || [];
  return match.map((token) => token.replace(/^(?:"|')|(?:"|')$/gu, ''));
}

function commandInfoOf(value) {
  const info = Array.isArray(value) ? value[0] : value;
  if (!info) return null;
  if (!Array.isArray(info) && typeof info !== 'object') return null;
  return {
    flags: Array.isArray(info.flags) ? info.flags : (info[2] || []),
    firstKey: Number(info.firstKey ?? info.first_key ?? info[3]),
    lastKey: Number(info.lastKey ?? info.last_key ?? info[4]),
    step: Number(info.step ?? info[5]) || 1,
  };
}

function keysOf(tokens, info) {
  if (!info || !Number.isInteger(info.firstKey) || info.firstKey <= 0) return [];
  const last = info.lastKey < 0 ? tokens.length + info.lastKey : info.lastKey;
  const keys = [];
  for (let index = info.firstKey; index <= last && index < tokens.length; index += info.step) {
    keys.push(tokens[index]);
  }
  return keys;
}

/** Закрываются оба соединения сессии: рабочее и служебное для SCRIPT KILL. */
async function closeHandle(handle) {
  const client = handle?.client || handle;
  await Promise.allSettled([client?.quit?.(), handle?.control?.quit?.()]);
}

export default {
  id: 'redis',
  label: 'Redis',
  capabilities: { schema: true, readOnly: true, estimate: true, cancel: 'script' },
  async open({ profile, password, stream, openStream, driver = Redis } = {}) {
    const base = {
      host: profile?.host,
      port: Number(profile?.port) || 6379,
      username: profile?.user || undefined,
      password: Buffer.isBuffer(password) ? password.toString('utf8') : String(password || ''),
      db: Number(profile?.database) || 0,
      lazyConnect: false,
      enableOfflineQueue: false,
    };
    const client = new driver({ ...base, ...(stream ? { stream } : {}) });

    // Служебное соединение нужно только затянувшемуся скрипту: снять его иначе
    // нечем, а пароль для отдельного подключения позже уже недоступен.
    let control = null;
    try {
      const controlStream = stream && typeof openStream === 'function' ? await openStream() : null;
      if (!stream || controlStream) {
        control = new driver({ ...base, ...(controlStream ? { stream: controlStream } : {}) });
      }
    } catch {
      control = null;
    }

    const handle = { client, control, readOnlyActive: profile?.role === 'read' };
    handle.close = () => closeHandle(handle);
    return handle;
  },
  close: closeHandle,
  async schema(handle) {
    const client = handle?.client || handle;
    return client.scan(0, 'COUNT', 100);
  },
  async analyze(text, handle) {
    const tokens = tokensOf(text);
    if (!tokens.length || /[;\n]/u.test(String(text || ''))) {
      return { queryClass: 'unknown', single: false, tables: [], forbidden: [] };
    }
    const command = tokens[0].toUpperCase();
    const info = typeof handle?.commandInfo === 'function'
      ? await handle.commandInfo(command)
      : await (handle?.client || handle)?.call?.('COMMAND', 'INFO', command);
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
  async inspectRights(handle, profile = {}) {
    const client = handle?.client || handle;
    const response = await client.call('ACL', 'GETUSER', profile.user || 'default');
    const text = JSON.stringify(response).toLowerCase();
    const writable = /\+@all|\+@write|\+(?:set|del|mset|hset|lpush|sadd)\b/u.test(text);
    return { confirmedReadOnly: !writable && /\+@read|\+get\b/u.test(text), writable };
  },
  async estimate(handle, analysis = {}, limits = {}) {
    const command = String(analysis.command || '').toUpperCase();
    const tokens = analysis.tokens || tokensOf(analysis.text);
    const timeoutMs = Number(limits.timeoutMs) || 15_000;
    if (analysis.queryClass === 'write') {
      return {
        rows: Math.max(1, analysis.tables?.length || 0),
        bytes: 0,
        timeoutMs,
      };
    }
    if (command === 'GET' && tokens[1]) {
      const client = handle?.client || handle;
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
  async execute(handle, request = {}) {
    const client = handle?.client || handle;
    const tokens = tokensOf(request.text);
    const result = await client.call(...tokens);
    return Array.isArray(result) ? result.map((value) => ({ value })) : [{ value: result }];
  },
  async cancel(handle, run = {}) {
    const command = String(
      run.command || String(run.text || '').trim().split(/\s+/u)[0] || '',
    ).toUpperCase();
    const killer = ['EVAL', 'EVALSHA'].includes(command)
      ? ['SCRIPT', 'KILL']
      : (['FCALL', 'FCALL_RO'].includes(command) ? ['FUNCTION', 'KILL'] : null);
    if (handle?.control && killer) {
      try {
        await handle.control.call(...killer);
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
