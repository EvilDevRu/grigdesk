// Хранилище кредов B24. Редактируются из «Настроек», лежат в .state (gitignore, mode 0600).
// GrigDesk — единственный владелец сессии, поэтому и куки, и креды держит у себя.
import fs from 'node:fs';
import path from 'node:path';

// Полные креды портала. Наружу они не уходят никогда — только `publicView`.
export interface B24Creds {
  baseUrl: string;
  login: string;
  password: string;
}

import type { B24CredsView } from '../../../../shared/b24/credentialsContracts.ts';

export type { B24CredsView } from '../../../../shared/b24/credentialsContracts.ts';

export class CredsStore {
  private driverCredentialsPath: string;

  readonly credsPath: string;

  readonly defaultBaseUrl: string;

  constructor({ credsPath, baseUrl, trackerCredentialsPath }: {
    credsPath: string;
    baseUrl: string;
    trackerCredentialsPath?: string;
  }) {
    this.credsPath = credsPath;
    this.defaultBaseUrl = baseUrl;
    this.driverCredentialsPath = trackerCredentialsPath
      ?? path.join(path.dirname(credsPath), 'tracker-credentials.json');
  }

  /**
   * Runtime задаёт независимый путь секретов до первого чтения драйверов.
   * Legacy-файл кастомного подключения сохраняет прежний формат и расположение.
   */
  useTrackerCredentialsPath(file: string): void {
    this.driverCredentialsPath = file;
  }

  /**
   * Каждый host получает только реквизиты своего драйвера.
   * Ошибка чтения закрывает подключение, не раскрывая содержимое файла клиенту.
   */
  readFor(id: string): Record<string, unknown> | null {
    if (id === 'b24-custom') {
      const legacy = this.read();

      return legacy ? { ...legacy } : null;
    }

    try {
      const stored = JSON.parse(fs.readFileSync(this.driverCredentialsPath, 'utf8'));

      return stored[id] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Пустое поле секрета сохраняет прежнее значение при повторном открытии формы.
   * Секреты записываются отдельно от выбора доски с правами только владельца.
   */
  writeFor(id: string, values: Record<string, unknown>): void {
    const merged = { ...this.readFor(id) };

    for (const [key, value] of Object.entries(values)) {
      if (value !== '') {
        merged[key] = value;
      }
    }

    if (id === 'b24-custom') {
      this.write(merged);

      return;
    }

    let stored: Record<string, unknown> = {};

    try {
      stored = JSON.parse(fs.readFileSync(this.driverCredentialsPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    stored[id] = merged;
    fs.mkdirSync(path.dirname(this.driverCredentialsPath), { recursive: true });

    const temporary = `${this.driverCredentialsPath}.tmp`;

    fs.writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.driverCredentialsPath);
  }

  /** Полные креды или null, если портал ещё не настроен. */
  read(): B24Creds | null {
    try {
      const raw = fs.readFileSync(this.credsPath, 'utf8');
      const c = JSON.parse(raw) as Partial<B24Creds>;

      if (!c.login || !c.password) return null;

      return {
        baseUrl: c.baseUrl || this.defaultBaseUrl,
        login: c.login,
        password: c.password,
      };
    } catch {
      return null;
    }
  }

  /** Есть ли валидные креды. */
  has(): boolean {
    return this.read() !== null;
  }

  /** Сохраняет креды (перезаписывает файл, права 0600). */
  write({ login, password, baseUrl }: Partial<B24Creds>): { baseUrl: string; login: string } {
    if (!login || !password) throw new Error('login и password обязательны');
    fs.mkdirSync(path.dirname(this.credsPath), { recursive: true });
    const data: B24Creds = {
      baseUrl: baseUrl || this.defaultBaseUrl,
      login,
      password,
    };
    fs.writeFileSync(this.credsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return { baseUrl: data.baseUrl, login: data.login };
  }

  /** Безопасное представление для UI (без пароля). */
  publicView(): B24CredsView {
    const c = this.read();
    if (!c) return { configured: false, baseUrl: this.defaultBaseUrl, login: '' };
    return { configured: true, baseUrl: c.baseUrl, login: c.login };
  }
}
