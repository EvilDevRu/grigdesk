import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { prepareExternalCliRuntime } from '../providerInstall/externalCliRuntime.ts';
import { acquireCliLease, type CliLease } from '../providerInstall/leases.ts';

import type { AccessStep } from '../../../../shared/chat/accessProfileContracts.ts';
import type { AccessCapability, AccessDriverContext, VerifiedAccess } from './types.ts';

interface CliCallbacks {
  started(pid: number): Promise<void>;
  step(step: AccessStep): Promise<void>;
  complete(value: VerifiedAccess): Promise<void>;
  failed(code: string): Promise<void>;
}

export interface CliAttemptProcess {
  finished: Promise<void>;
  input(value: Record<string, unknown>): Promise<void>;
  cancel(): Promise<void>;
}

const execute = promisify(execFile);

/**
 * URL авторизации допускается только по списку адаптера и с HTTPS.
 * Сырой терминальный вывод не является публичным сообщением ошибки.
 */
function safeUrl(value: string, hosts: string[]): string | null {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' && hosts.includes(url.hostname)
      && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Один процесс login принадлежит одной серверной попытке и одному приватному home.
 * Версия, argv и окружение выбираются адаптером до принятия какого-либо кода.
 */
export async function startCliLogin(capability: AccessCapability,
  context: AccessDriverContext, callbacks: CliCallbacks): Promise<CliAttemptProcess> {
  const runtime = await prepareExternalCliRuntime(context.adapter, context.config, context.env);
  const lease = runtime ? await acquireCliLease({
    directory: runtime.process.leaseDirectory,
    providerId: context.adapter.id,
    resourceKey: runtime.process.resourceKey,
    mode: 'reader',
    jobId: 'access-login',
  }) : undefined;

  try {
    return await startManagedLogin(capability, {
      ...context,
      config: runtime?.config ?? context.config,
      env: runtime ? { ...context.env, PATH: runtime.process.env.PATH } : context.env,
    }, callbacks, lease);
  } catch (error) {
    await lease?.release();

    throw error;
  }
}

/**
 * Reader установки уже получен после access admission и остаётся до выхода login.
 * Пользовательский ввод передаётся лишь процессу с подтверждённой версией протокола.
 */
async function startManagedLogin(capability: AccessCapability,
  context: AccessDriverContext, callbacks: CliCallbacks, lease?: CliLease): Promise<CliAttemptProcess> {
  const cli = capability.cli!;
  const executable = String(context.adapter.bin(context.config));
  const env: NodeJS.ProcessEnv = {
    PATH: context.env.PATH ?? process.env.PATH,
    HOME: context.home,
    XDG_CONFIG_HOME: path.join(context.home, 'config'),
    XDG_DATA_HOME: path.join(context.home, 'data'),
    XDG_STATE_HOME: path.join(context.home, 'state'),
    XDG_CACHE_HOME: path.join(context.home, 'cache'),
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    PYTHONDONTWRITEBYTECODE: '1',
    [capability.homeKey!]: context.home,
  };

  await fs.mkdir(context.home, { recursive: true, mode: 0o700 });

  const version = await execute(executable, ['--version'], {
    env,
    timeout: 10_000,
    maxBuffer: 8192,
  });

  if (!new RegExp(`(^|[^0-9])${cli.version.replaceAll('.', '\\.')}([^0-9]|$)`, 'u')
    .test(version.stdout)) {
    await callbacks.failed('unsupported');
    await lease?.release();

    return {
      finished: Promise.resolve(),
      input: async () => {},
      cancel: async () => {},
    };
  }

  const rpc = cli.protocol === 'codex-rpc';
  const processOptions = {
    env,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    detached: true,
  };
  const child = rpc
    ? spawn(executable, cli.args, processOptions)
    : spawn('python3', [fileURLToPath(new URL('./authPty.py', import.meta.url)), executable, ...cli.args],
      processOptions);
  const exited = once(child, 'exit').catch(() => {});
  const closed = once(child, 'close');

  const finished = closed.then(async () => {
    await lease?.release();
  });

  void finished.catch(() => {});

  const deadline = setTimeout(() => {
    void callbacks.failed('expired').finally(cancel).catch(() => {});
  }, 10 * 60_000);

  deadline.unref();

  let terminal = false;
  let buffer = '';
  let queued = Promise.resolve();
  let stage = '';
  const handshake = setTimeout(() => {
    if (!stage) {
      void callbacks.failed(rpc ? 'unavailable' : 'unsupported').finally(cancel).catch(() => {});
    }
  }, 30_000);

  handshake.unref();

  /**
   * Остановка касается только группы дочернего login текущего driver.
   * Завершение ожидается до освобождения попытки, принудительное — после короткого срока.
   */
  async function cancel(): Promise<void> {
    terminal = true;
    clearTimeout(deadline);
    clearTimeout(handshake);

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    if (rpc && stage) {
      send(4, 'account/login/cancel', { loginId: stage });
    }

    child.kill('SIGTERM');

    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Группа уже завершилась между проверкой и сигналом.
      }
    }, 1000);

    await exited.catch(() => {});
    clearTimeout(timeout);
  }

  const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(`${JSON.stringify({
      id,
      method,
      params,
    })}\n`);
  };

  /**
   * Проверка завершения отделена от показа ссылки и нажатия кнопки.
   * Для ручного flow используется штатный auth status; device flow проверяет результат CLI.
   */
  async function complete(account?: Record<string, unknown>): Promise<void> {
    if (terminal) {
      return;
    }

    const credential = await fs.readFile(path.join(context.home, cli.credentialFile), 'utf8');

    if (!credential || credential.length > 1024 * 1024) {
      throw new Error('Не подтверждён доступ');
    }

    let identity = account;

    if (cli.protocol === 'manual-code') {
      const result = await execute(executable, ['auth', 'status'],
        {
          env,
          timeout: 10_000,
          maxBuffer: 8192,
        });

      identity = JSON.parse(result.stdout) as Record<string, unknown>;

      if (identity.loggedIn !== true) {
        throw new Error('Не подтверждён доступ');
      }
    }

    await callbacks.complete({
      env: {
        [capability.homeKey!]: context.home,
        HOME: context.home,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: env.XDG_DATA_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
        XDG_CACHE_HOME: env.XDG_CACHE_HOME,
      },
      evidence: identity && typeof identity.email === 'string'
        ? { kind: 'known', account: identity.email } : { kind: 'unknown' },
    });
    await cancel();
  }

  /**
   * Программный протокол разбирается только по закрытому набору ответов.
   * LoginId связывает уведомление завершения с ожидающим device flow.
   */
  async function onRpc(message: Record<string, unknown>): Promise<void> {
    const result = message.result as Record<string, unknown> | undefined;

    if (message.error) {
      await callbacks.failed('unavailable');
      await cancel();
    } else if (message.id === 1) {
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      send(2, 'account/login/start', { type: 'chatgptDeviceCode' });
    } else if (message.id === 2 && result) {
      const url = safeUrl(String(result.verificationUrl), cli.hosts);

      if (!url || typeof result.userCode !== 'string' || typeof result.loginId !== 'string') {
        throw new Error('Неизвестный протокол входа');
      }

      stage = result.loginId;
      clearTimeout(handshake);
      await callbacks.step({
        id: randomUUID(),
        kind: 'display-code',
        url,
        code: result.userCode,
      });
    } else if (message.method === 'account/login/completed') {
      const params = message.params as Record<string, unknown>;

      if (params.loginId === stage && params.success === true) {
        await callbacks.step({ id: randomUUID(), kind: 'verifying' });
        send(3, 'account/read', { refreshToken: false });
      } else {
        await callbacks.failed('auth_required');
        await cancel();
      }
    } else if (message.id === 3) {
      const account = result?.account as Record<string, unknown> | undefined;

      if (account?.type !== 'chatgpt') {
        throw new Error('Не подтверждён аккаунт ChatGPT');
      }

      await complete(account);
    }
  }

  /**
   * Текстовые prompts принимаются только для подтверждённой версии и URL адаптера.
   * Буфер ограничен, ANSI и исходный текст не пересылаются в SSE или историю.
   */
  async function consume(chunk: Buffer): Promise<void> {
    if (terminal) {
      return;
    }

    buffer += chunk.toString('utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '');

    if (buffer.length > 32768) {
      throw new Error('Неизвестный протокол входа');
    }

    if (rpc) {
      let newline;

      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);

        buffer = buffer.slice(newline + 1);
        await onRpc(JSON.parse(line) as Record<string, unknown>);
      }

      return;
    }

    const url = safeUrl(buffer.match(/https:\/\/[^\s\x1b]+/u)?.[0] ?? '', cli.hosts);

    if (cli.protocol === 'manual-code' && url && buffer.includes('Paste code here') && !stage) {
      stage = 'input';
      clearTimeout(handshake);
      await callbacks.step({
        id: randomUUID(),
        kind: 'enter-code',
        url,
      });
    } else if (cli.protocol === 'device-code' && url && !stage) {
      const code = buffer.match(/enter code:\s*([A-Z0-9-]+)/u)?.[1];

      if (code) {
        stage = 'waiting';
        clearTimeout(handshake);
        await callbacks.step({
          id: randomUUID(),
          kind: 'display-code',
          url,
          code,
        });
      }
    }

    if (buffer.includes('Login successful.') || buffer.includes('Logged in to kimi-code.')) {
      await callbacks.step({ id: randomUUID(), kind: 'verifying' });
      await complete();
    }
  }

  const receive = (chunk: Buffer) => {
    queued = queued.then(() => consume(chunk)).catch(async () => {
      await callbacks.failed('unsupported');
      await cancel();
    });
  };

  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  child.on('error', () => {
    void callbacks.failed('interrupted');
  });
  child.on('exit', () => {
    clearTimeout(deadline);
    clearTimeout(handshake);
    void queued.then(async () => {
      if (!terminal) {
        await callbacks.failed('interrupted');
      }
    });
  });

  try {
    if (child.pid) {
      await callbacks.started(child.pid);
      await lease?.attachSession(child.pid);
      await lease?.attachChild(child.pid);
    }
  } catch (error) {
    await cancel();

    throw error;
  }

  if (rpc) {
    send(1, 'initialize', { clientInfo: { name: 'grigdesk', version: '1' }, capabilities: {} });
  } else {
    // PTY не запускает login до durable identity: авария сервера закрывает этот вход.
    child.stdin.write(Buffer.from([0]));
  }

  return {
    finished,
    cancel,
    async input(value) {
      if (terminal || stage !== 'input' || typeof value.code !== 'string'
        || !value.code.trim() || value.code.length > 4096 || /[\r\n\0]/u.test(value.code)) {
        throw new Error('Недопустимый код входа');
      }

      stage = 'submitted';
      child.stdin.write(`${value.code.trim()}\n`);
    },
  };
}
