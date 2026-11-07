// Закрытое состояние входа. Лежит в СВОЁМ каталоге с правами 0700/0600, отдельно
// от артефактов ролика: снимок входа — это действующие права тестовой учётки,
// и попасть в скачиваемый файл, экспорт или журнал он не должен.
//
// Наружу отдаётся только факт наличия и срок годности. Содержимое не проходит
// через ручки, события и ответы моделей ни в каком виде.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface LoginStateStatus {
  present: boolean;
  expiresAt: string | null;
  // Отпечаток пары «цель + учётка»: снимок, снятый для другой цели или другой
  // учётки, не подходит, даже если он ещё не истёк.
  bindingMatches: boolean;
}

export interface ShowcaseLoginStoreOptions {
  authDir: string;
  ttlMs?: number;
}

interface StoredLogin {
  binding: string;
  savedAt: string;
  expiresAt: string;
  state: unknown;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

function bindingOf(targetFingerprint: string, credentialsRef: string): string {
  return createHash('sha256')
    .update(`${targetFingerprint} ${credentialsRef}`)
    .digest('hex')
    .slice(0, 32);
}

export function createShowcaseLoginStore(options: ShowcaseLoginStoreOptions) {
  const { authDir, ttlMs = DEFAULT_TTL_MS } = options;

  function fileOf(binding: string): string {
    return path.join(authDir, `${binding}.json`);
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    await fs.chmod(authDir, 0o700).catch(() => null);
  }

  async function remove(targetFingerprint: string, credentialsRef: string): Promise<void> {
    await fs.rm(fileOf(bindingOf(targetFingerprint, credentialsRef)), { force: true });
  }

  async function read(targetFingerprint: string, credentialsRef: string): Promise<unknown | null> {
    const binding = bindingOf(targetFingerprint, credentialsRef);
    let stored: StoredLogin;

    try {
      stored = JSON.parse(await fs.readFile(fileOf(binding), 'utf8')) as StoredLogin;
    } catch {
      return null;
    }

    // Истёкший снимок не «почти годный»: вход обновляется до записи, иначе сцена
    // снимет экран логина вместо продукта.
    if (stored.binding !== binding || Date.parse(stored.expiresAt) <= Date.now()) {
      await remove(targetFingerprint, credentialsRef);

      return null;
    }

    return stored.state;
  }

  async function save(
    targetFingerprint: string,
    credentialsRef: string,
    state: unknown,
  ): Promise<void> {
    await ensureDir();

    const binding = bindingOf(targetFingerprint, credentialsRef);
    const file = fileOf(binding);
    const temporary = `${file}.tmp`;
    const stored: StoredLogin = {
      binding,
      savedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      state,
    };

    await fs.writeFile(temporary, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  }

  /**
   * Состояние для интерфейса. Содержимое снимка сюда не попадает по определению:
   * человеку нужно знать, есть ли вход и когда он истечёт, а не какие в нём куки.
   */
  async function status(
    targetFingerprint: string,
    credentialsRef: string,
  ): Promise<LoginStateStatus> {
    const binding = bindingOf(targetFingerprint, credentialsRef);

    try {
      const stored = JSON.parse(await fs.readFile(fileOf(binding), 'utf8')) as StoredLogin;

      return {
        present: Date.parse(stored.expiresAt) > Date.now(),
        expiresAt: stored.expiresAt,
        bindingMatches: stored.binding === binding,
      };
    } catch {
      return { present: false, expiresAt: null, bindingMatches: false };
    }
  }

  /** Отзыв доступа и удаление ролика снимают все снимки разом. */
  async function clear(): Promise<void> {
    await fs.rm(authDir, { recursive: true, force: true });
  }

  return { clear, ensureDir, read, remove, save, status };
}

export type ShowcaseLoginStore = ReturnType<typeof createShowcaseLoginStore>;
