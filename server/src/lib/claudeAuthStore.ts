// Авторизация Claude для чата кокпита.
// По умолчанию чат использует авторизацию ХОСТОВОГО CLI (`claude login` кладёт токен в
// ~/.claude/.credentials.json, либо ANTHROPIC_API_KEY в окружении). Опционально кокпит
// может держать СВОЙ API-ключ (для отдельного биллинга инструмента) — он передаётся
// подпроцессу `claude -p` как ANTHROPIC_API_KEY. Ключ лежит в .state (gitignore, 0600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Чем именно авторизован чат. Различать обязательно: свой ключ кокпита — это отдельный
// счёт, а хостовой CLI человек мог разлогинить, не трогая кокпит.
export type ClaudeAuthMode = 'apikey' | 'env' | 'cli' | 'none';

// Безопасное представление для UI: сам ключ наружу не уходит никогда.
export interface ClaudeAuthView {
  mode: ClaudeAuthMode;
  configured: boolean;
  keyHint: string | null;
  hostLoggedIn: boolean;
}

export class ClaudeAuthStore {
  readonly authPath: string;

  constructor({ authPath }: { authPath: string }) {
    this.authPath = authPath;
  }

  /** Свой ключ кокпита или null. */
  read(): { apiKey: string } | null {
    try {
      const c = JSON.parse(fs.readFileSync(this.authPath, 'utf8')) as { apiKey?: unknown };

      return c.apiKey ? { apiKey: String(c.apiKey) } : null;
    } catch {
      return null;
    }
  }

  write(apiKey: unknown): void {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('пустой ключ');
    fs.mkdirSync(path.dirname(this.authPath), { recursive: true });
    fs.writeFileSync(this.authPath, JSON.stringify({ apiKey: key }, null, 2), { mode: 0o600 });
  }

  clear(): void {
    try {
      fs.unlinkSync(this.authPath);
    } catch {
      /* нет файла */
    }
  }

  /** Статус авторизации хостового CLI (без раскрытия секретов). */
  hostStatus(): { hasCli: boolean; hasEnvKey: boolean } {
    const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
    return { hasCli: fs.existsSync(credFile), hasEnvKey: !!process.env.ANTHROPIC_API_KEY };
  }

  /** Безопасное представление для UI (без ключа). */
  publicView(): ClaudeAuthView {
    const own = this.read();
    const host = this.hostStatus();
    const mode = own ? 'apikey' : host.hasEnvKey ? 'env' : host.hasCli ? 'cli' : 'none';
    return {
      mode,                                   // apikey | env | cli | none
      configured: !!own,                      // задан ли собственный ключ кокпита
      keyHint: own ? `…${own.apiKey.slice(-4)}` : null,
      hostLoggedIn: host.hasCli || host.hasEnvKey,
    };
  }

  /** Окружение для подпроцесса claude: со своим ключом (если задан) — иначе как у хоста. */
  env(): NodeJS.ProcessEnv {
    const own = this.read();
    return own ? { ...process.env, ANTHROPIC_API_KEY: own.apiKey } : process.env;
  }
}
