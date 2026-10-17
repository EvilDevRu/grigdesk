// Сессии входа и владелец локальных данных кокпита.
//
// Модель: ОДИН пользователь, вход только обменом локального ключа окна. Пароля здесь больше
// нет: прежний файл учётной записи читается один раз как источник строки `clientScope` —
// владельца незавершённых операций 3D, сохранённых прежней версией. Хеш не проверяется,
// не переносится и не публикуется, а сам старый файл не удаляется и не переписывается.
//
// Файл сессий версии 2 хранит scope и карту «идентификатор → срок годности». Плоская карта
// старого формата не принимается даже с неистёкшими сессиями: после перехода на вход
// по ключу прежние сессии требуют одного повторного входа.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 400 дней — предел срока cookie в Chromium: больший срок ничего не даёт.
const SESSION_TTL_MS = 400 * 24 * 3600 * 1000;
// Хранилище не растёт бесконечно: новая сессия вытесняет самую старую.
const SESSION_LIMIT = 20;
const SESSION_ID_BYTES = 32;
const SESSIONS_VERSION = 2;

// Документ файла сессий. Версия обязательна: без неё файл считается чужим.
export interface SessionsDocument {
  version: number;
  clientScope: string;
  sessions: Record<string, number>;
}

export interface AuthStoreOptions {
  // Прежний файл учётной записи. Источник миграции и ничего больше.
  legacyAccountPath: string;
  sessionsPath: string;
  now?: () => number;
}

/**
 * Новый документ сессий. Повреждённый файл, чужая версия и плоская карта старого формата
 * дают ровно тот же результат — пустой набор и повторный перенос scope из прежней учётки.
 */
function readSessionsDocument(file: string): SessionsDocument | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const document = raw as Partial<SessionsDocument>;

    if (document === null || typeof document !== 'object'
      || document.version !== SESSIONS_VERSION
      || typeof document.clientScope !== 'string'
      || document.sessions === null || typeof document.sessions !== 'object') {
      return null;
    }

    return {
      version: SESSIONS_VERSION,
      clientScope: document.clientScope,
      sessions: document.sessions as Record<string, number>,
    };
  } catch {
    return null;
  }
}

export class AuthStore {
  // Источник миграции. В авторизации не участвует и продуктом не переписывается.
  readonly legacyAccountPath: string;

  readonly sessionsPath: string;

  // sessionId → срок годности в миллисекундах.
  readonly sessions: Map<string, number>;

  // Владелец сохранённых локальных данных. Пустая строка — как в прежнем API.
  clientScope = '';

  private readonly _now: () => number;

  constructor({ legacyAccountPath, sessionsPath, now }: AuthStoreOptions) {
    this.legacyAccountPath = legacyAccountPath;
    this.sessionsPath = sessionsPath;
    this._now = now ?? Date.now;
    this.sessions = new Map();
    this._load();
  }

  // ── Загрузка и миграция ──

  /**
   * Загрузка состояния с диска.
   *
   * Читается только документ версии 2. Всё остальное — отсутствие файла, повреждение,
   * чужая версия, плоская карта старого формата — означает пустой набор сессий и
   * повторный перенос scope из прежней учётной записи.
   */
  private _load(): void {
    const document = readSessionsDocument(this.sessionsPath);

    if (document === null) {
      this.clientScope = this._readLegacyScope();

      return;
    }

    this.clientScope = document.clientScope;

    const now = this._now();

    for (const [id, expiresAt] of Object.entries(document.sessions)) {
      if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now) {
        this.sessions.set(id, expiresAt);
      }
    }
  }

  /**
   * Строка владельца из прежнего файла учётной записи: `login` или пустая строка.
   * Отсутствующее и нечитаемое значение одинаково дают пустую строку.
   */
  private _readLegacyScope(): string {
    try {
      const account: unknown = JSON.parse(fs.readFileSync(this.legacyAccountPath, 'utf8'));
      const login = (account as { login?: unknown } | null)?.login;

      return typeof login === 'string' ? login : '';
    } catch {
      return '';
    }
  }

  // ── Сессии ──

  /**
   * Новая сессия сохраняется на диск: рестарт сервера не должен разлогинивать окно.
   * Перед записью лишние сессии вытесняются, чтобы файл не противоречил памяти.
   */
  createSession(): { id: string; maxAgeSec: number } {
    const id = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');

    this.sessions.set(id, this._now() + SESSION_TTL_MS);
    this._evictOldest();
    this._save();

    return { id, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
  }

  /**
   * Валидна ли сессия.
   *
   * Просроченная запись попутно удаляется с записью файла: иначе карта росла бы
   * неограниченно, а срок годности оставался бы только в комментариях.
   */
  isValidSession(id: string | undefined | null): boolean {
    if (!id) {
      return false;
    }

    const expiresAt = this.sessions.get(id);

    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= this._now()) {
      this.sessions.delete(id);
      this._save();

      return false;
    }

    return true;
  }

  /**
   * Вытеснение самой старой сессии: двадцатая по счёту остаётся, предыдущие уходят.
   * Самая старая определяется по сроку годности, а не по порядку ключей в файле.
   */
  private _evictOldest(): void {
    while (this.sessions.size > SESSION_LIMIT) {
      let oldestId: string | null = null;
      let oldestExpiry = Infinity;

      for (const [id, expiresAt] of this.sessions) {
        if (expiresAt < oldestExpiry) {
          oldestId = id;
          oldestExpiry = expiresAt;
        }
      }

      if (oldestId === null) {
        return;
      }

      this.sessions.delete(oldestId);
    }
  }

  /**
   * Атомарная запись: временный файл 0600 в том же каталоге, затем rename.
   * Неудачная запись не оставляет временных файлов и не портит прежний документ.
   */
  private _save(): void {
    const directory = path.dirname(this.sessionsPath);
    const temporary = path.join(directory,
      `.${path.basename(this.sessionsPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`);

    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({
        version: SESSIONS_VERSION,
        clientScope: this.clientScope,
        sessions: Object.fromEntries(this.sessions),
      }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.sessionsPath);
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch { /* временного файла уже нет — убирать нечего */ }
    }
  }
}
