// Учётная запись кокпита и сессии входа.
//
// Модель: ОДИН пользователь (логин + пароль). Пульт личный, поэтому пользователей и ролей нет —
// нечего перечислять и нечего угадывать.
//
// Почему не `COCKPIT_TOKEN`: тот секрет обязан попасть во фронт через `VITE_COCKPIT_TOKEN`,
// а Vite подставляет env-переменные в бандл на этапе сборки — секрет оказывается в публичном JS
// открытым текстом (проверено). Здесь наоборот: на диске только ХЕШ пароля, клиент получает
// лишь идентификатор сессии в httpOnly-cookie, и никакой секрет в JS не живёт.
//
// Без внешних зависимостей: scrypt и timingSafeEqual есть в node:crypto.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Параметры scrypt. N=2^15 — заметная стоимость перебора при незаметной задержке на вход.
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;
// maxmem задаём ЯВНО: scrypt требует 128*N*r = ровно 32 МиБ, а столько же составляет дефолтный
// лимит Node — вызов упирается в него и падает «memory limit exceeded». Даём запас вдвое.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 дней: пульт открывают с планшета, каждый день логиниться незачем
const SESSION_ID_BYTES = 32;

/**
 * Хеш пароля в самодостаточном виде: параметры + соль + хеш в одной строке.
 * Так можно поднять стоимость в будущем, не ломая уже сохранённые пароли.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Проверка пароля против сохранённого хеша. Сравнение — timing-safe: обычное `===`
 * на строках выходит из цикла на первом различии и подсказывает длину общего префикса.
 */
function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), keyHex.length / 2, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    });
    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length !== key.length) return false;
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export class AuthStore {
  /** @param {{ accountPath: string, sessionsPath: string }} opts */
  constructor({ accountPath, sessionsPath }) {
    this.accountPath = accountPath;
    this.sessionsPath = sessionsPath;
    /** @type {Map<string, number>} sessionId → срок годности (ms) */
    this.sessions = new Map();
    this._loadSessions();
  }

  // ── Учётная запись ──

  /** { login, hash } или null, если пароль ещё не задан. */
  readAccount() {
    try {
      const a = JSON.parse(fs.readFileSync(this.accountPath, 'utf8'));
      if (!a.hash) return null;
      return { login: a.login || '', hash: a.hash };
    } catch {
      return null;
    }
  }

  /** Настроен ли вход. Пока нет — кокпит показывает первичную настройку пароля. */
  isConfigured() {
    return this.readAccount() !== null;
  }

  /**
   * Задать логин и пароль. Все существующие сессии сбрасываются: смена пароля обязана
   * выкидывать всех, иначе украденная cookie продолжает работать.
   */
  setCredentials({ login, password }) {
    if (!password || password.length < 8) throw new Error('Пароль должен быть не короче 8 символов');
    fs.mkdirSync(path.dirname(this.accountPath), { recursive: true });
    fs.writeFileSync(
      this.accountPath,
      JSON.stringify({ login: login || '', hash: hashPassword(password) }, null, 2),
      { mode: 0o600 },
    );
    this.dropAllSessions();
    return { login: login || '' };
  }

  /** Проверка логина и пароля. Логин сверяем, только если он задан. */
  check({ login, password }) {
    const acc = this.readAccount();
    if (!acc) return false;
    if (acc.login && String(login || '') !== acc.login) {
      // Пароль всё равно прогоняем: иначе по времени ответа видно, угадан ли логин.
      verifyPassword(String(password || ''), acc.hash);
      return false;
    }
    return verifyPassword(String(password || ''), acc.hash);
  }

  // ── Сессии ──

  _loadSessions() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8'));
      const now = Date.now();
      for (const [id, exp] of Object.entries(raw || {})) {
        if (typeof exp === 'number' && exp > now) this.sessions.set(id, exp);
      }
    } catch { /* нет файла — пустой набор */ }
  }

  _saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this.sessionsPath), { recursive: true });
      fs.writeFileSync(
        this.sessionsPath,
        JSON.stringify(Object.fromEntries(this.sessions)),
        { mode: 0o600 },
      );
    } catch { /* не смогли сохранить — сессии переживут только до перезапуска */ }
  }

  /** Новая сессия. Сохраняем на диск: рестарт сервера не должен выкидывать с планшета. */
  createSession() {
    const id = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
    this.sessions.set(id, Date.now() + SESSION_TTL_MS);
    this._saveSessions();
    return { id, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
  }

  /** Валидна ли сессия (с попутной очисткой просроченных). */
  isValidSession(id) {
    if (!id) return false;
    const exp = this.sessions.get(id);
    if (!exp) return false;
    if (exp <= Date.now()) {
      this.sessions.delete(id);
      this._saveSessions();
      return false;
    }
    return true;
  }

  dropSession(id) {
    if (id && this.sessions.delete(id)) this._saveSessions();
  }

  /** «Выйти со всех устройств». */
  dropAllSessions() {
    this.sessions.clear();
    this._saveSessions();
  }

  /** Безопасное представление для UI. */
  publicView() {
    const acc = this.readAccount();
    return {
      configured: !!acc,
      login: acc?.login || '',
      sessions: this.sessions.size,
    };
  }
}
