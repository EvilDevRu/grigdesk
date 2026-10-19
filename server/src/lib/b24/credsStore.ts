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
  readonly credsPath: string;

  readonly defaultBaseUrl: string;

  constructor({ credsPath, baseUrl }: { credsPath: string; baseUrl: string }) {
    this.credsPath = credsPath;
    this.defaultBaseUrl = baseUrl;
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
