import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Спрашивает свободный loopback-порт внутри namespace и закрывает probe.
 * Основной и мобильный порты выбираются отдельными вызовами с проверкой различия.
 */
export async function freePort(): Promise<number> {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const port = (server.address() as { port: number }).port;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

/**
 * Allowlist принадлежит namespace: никакое окружение пользователя не наследуется.
 * Все фоновые сервисы, фабрика, credentials и данные направлены в D.
 */
export function environment(): NodeJS.ProcessEnv {
  return {
    PATH: '/host-bin:/usr/bin:/bin',
    HOME: '/D/home',
    XDG_CONFIG_HOME: '/D/xdg/config',
    XDG_DATA_HOME: '/D/xdg/data',
    XDG_CACHE_HOME: '/D/xdg/cache',
    GRIGDESK_HOME: '/D',
    NODE_ENV: 'production',
    GRIGDESK_WINDOW_KEY_PATH: '/D/window-auth/key',
    GRIGDESK_MOBILE_DIR: '/D/mobile',
    GRIGDESK_MOBILE_APK_DIR: '/D/mobile-apk',
    GRIGDESK_CHATS_DIR: '/D/chats',
    GRIGDESK_3D_DIR: '/D/3d',
    GRIGDESK_TELEGRAM_DIR: '/D/telegram',
    GRIGDESK_GITHUB_DIR: '/D/github',
    FACTORY_STATE_DIR: '/D/factory/state',
    FACTORY_CONTROL_ROOT: '/D/factory/control',
    FACTORY_CONFIG_ROOT: '/D/factory/config',
    FACTORY_PROFILES_DIR: '/D/profiles',
    GRIGDESK_ROUTES_DIR: '/D/routes',
    GRIGDESK_MEDIA_DIR: '/D/media',
    GRIGDESK_MEDIA_HF_DIR: '/D/hf',
    GRIGDESK_PLUGINS_DIR: '/D/plugins',
    GRIGDESK_PLUGINS_DATA_DIR: '/D/plugin-data',
    GRIGDESK_PLUGIN_INSTALLS_STATE_PATH: '/D/state/plugin-installs.json',
    GRIGDESK_SHOWCASE_DIR: '/D/showcase',
    GRIGDESK_SHOWCASE_AUTH_DIR: '/D/showcase-auth',
    GRIGDESK_SHOWCASE_VOICE_DIR: '/D/showcase-voice',
    GRIGDESK_SHOWCASE_BROWSER_DIR: '/D/showcase-browser',
    GRIGDESK_TICKETS_DIR: '/D/tickets',
    GRIGDESK_ANALYSIS_DIR: '/D/analysis',
    GRIGDESK_SSH_AUDIT_DIR: '/D/ssh',
    GRIGDESK_DB_AUDIT_DIR: '/D/db',
    GRIGDESK_SANDBOX_JOURNAL_DIR: '/D/sandbox',
    GRIGDESK_MODELS_PATH: '/D/state/models.json',
    GRIGDESK_USAGE_FORECAST_PATH: '/D/state/usage-forecast.json',
    GRIGDESK_WEB_LOG_DIR: '/D/web-log',
    GRIGDESK_UI_RELEASES_DIR: '/D/ui-releases',
    GRIGDESK_PREFS_PATH: '/D/state/prefs.json',
    GRIGDESK_AUTH_ACCOUNT: '/D/state/auth.json',
    GRIGDESK_AUTH_SESSIONS: '/D/state/sessions.json',
    GRIGDESK_CLI_TOKEN_PATH: '/D/state/cli-token',
    GRIGDESK_TASK_SHELF_PATH: '/D/state/shelf.json',
    GRIGDESK_TASK_SEEN_PATH: '/D/state/seen.json',
    GRIGDESK_TASK_FAVORITES_PATH: '/D/state/favorites.json',
    GRIGDESK_UPDATE_STATE_PATH: '/D/state/update.json',
    GRIGDESK_ARBITER_CARDS_PATH: '/D/state/arbiter.json',
    GRIGDESK_CLAUDE_AUTH_PATH: '/D/state/claude-auth.json',
    GRIGDESK_CHAT_STORE: '/D/state/chats.json',
    GRIGDESK_CHAT_BINDINGS_DIR: '/D/state/bindings',
    GRIGDESK_SSH_CONNECTIONS_PATH: '/D/state/ssh.json',
    GRIGDESK_SSH_KNOWN_HOSTS_PATH: '/D/state/known_hosts',
    GRIGDESK_DB_PROFILES_PATH: '/D/state/db.json',
    GRIGDESK_PROVIDER_USAGE_SEEN_PATH: '/D/state/usage.json',
    GRIGDESK_TELEGRAM_ACCOUNT_CREDS_PATH: '/D/state/telegram.json',
    GRIGDESK_GITHUB_CREDS_PATH: '/D/state/github.json',
  };
}

/**
 * Ограничивает ожидание процесса и снимает таймер после результата.
 * Таймаут — отказ, а не подстановка успешного кода завершения.
 */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Истёк срок ${ms} мс`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запускает только ребёнка driver и сохраняет его код/лог для диагностики.
 * Stop сигналит этому ChildProcess и ждёт exit; чужие PID не используются.
 */
export function tracked(file: string, args: string[], env: NodeJS.ProcessEnv,
  ipc = false) {
  const child = spawn(file, args, {
    cwd: '/D',
    env,
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let finished = false;
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => {
      log += error.message;
      finished = true;
      resolve({ code: null, signal: null });
    });
    child.once('exit', (code, signal) => {
      finished = true;
      resolve({ code, signal });
    });
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-65536);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-65536);
  });

  return {
    child,
    exited,
    finished: () => finished,
    log: () => log,
    /**
     * Закрывает только запущенного выше ребёнка и ждёт его окончательного exit.
     * Превышение срока остаётся ошибкой даже после принудительной уборки.
     */
    async stop(): Promise<ProcessExit> {
      if (!finished) {
        child.kill('SIGTERM');
      }

      try {
        return await within(exited, 45000);
      } catch (error) {
        child.kill('SIGKILL');
        await exited;

        throw error;
      }
    },
  };
}

/**
 * Готовность доказывается ответом сокета выбранного порта, а не строкой stdout.
 * Досрочный exit немедленно возвращает накопленный лог собственного процесса.
 */
export async function ready(run: ReturnType<typeof tracked>, port: number): Promise<void> {
  const deadline = Date.now() + 45000;

  while (Date.now() < deadline && !run.finished()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/state`, {
        signal: AbortSignal.timeout(500),
      });

      if (response.status === 200) {
        return;
      }
    } catch { /* listen ещё не завершён */ }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`SEA не готов: ${run.log()}`);
}
