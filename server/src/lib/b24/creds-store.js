// Хранилище кредов B24. Редактируются из «Настроек», лежат в .state (gitignore, mode 0600).
// Кокпит — единственный владелец сессии, поэтому и куки, и креды держит у себя.
import fs from 'node:fs';
import path from 'node:path';

export class CredsStore {
  /** @param {{ credsPath: string, baseUrl: string }} opts */
  constructor({ credsPath, baseUrl }) {
    this.credsPath = credsPath;
    this.defaultBaseUrl = baseUrl;
  }

  /** Возвращает { baseUrl, login, password } или null, если не настроено. */
  read() {
    try {
      const raw = fs.readFileSync(this.credsPath, 'utf8');
      const c = JSON.parse(raw);
      if (!c.login || !c.password) return null;
      return { baseUrl: c.baseUrl || this.defaultBaseUrl, login: c.login, password: c.password };
    } catch {
      return null;
    }
  }

  /** Есть ли валидные креды. */
  has() {
    return this.read() !== null;
  }

  /** Сохраняет креды (перезаписывает файл, права 0600). */
  write({ login, password, baseUrl }) {
    if (!login || !password) throw new Error('login и password обязательны');
    fs.mkdirSync(path.dirname(this.credsPath), { recursive: true });
    const data = { baseUrl: baseUrl || this.defaultBaseUrl, login, password };
    fs.writeFileSync(this.credsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return { baseUrl: data.baseUrl, login: data.login };
  }

  /** Безопасное представление для UI (без пароля). */
  publicView() {
    const c = this.read();
    if (!c) return { configured: false, baseUrl: this.defaultBaseUrl, login: '' };
    return { configured: true, baseUrl: c.baseUrl, login: c.login };
  }
}
