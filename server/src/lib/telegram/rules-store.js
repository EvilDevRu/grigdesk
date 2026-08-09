// Правила «чат/тема → проект» и их хранилище (`telegram/rules.json`).
//
// Это ALLOWLIST, а не удобная настройка: по границам безопасности плагина
// (docs/cockpit/inbox.md, раздел «Telegram») разворачивается только ссылка на
// чат, привязанный к проекту. Без правила — отказ, всегда. Иначе произвольная
// ссылка, вписанная в описание задачи, вытянула бы содержимое любого чата, где
// бот случайно состоит.
//
// Почему отдельным файлом, а не в prefs: `pluginSettings` — плоская карта
// «ключ: значение» из схемы манифеста, массив правил в неё не ложится (раздел 11).
//
// Форма правила:
//   { project, chatId|null, username|null, title, threadId|null, kind: 'bug'|'wish',
//     b24: { responsibleId, groupId, priority },
//     draft: 'manual'|'auto',
//     notifyTaskCreated: boolean,
//     autoTask: { enabled, minConfidence, maxPerDay },
//     autoLaunch: { enabled, route, minConfidence, maxPerDay, vetoMinutes } }
//
// Адрес чата хранится ДВУМЯ сторонами, и обе нужны: ссылка на приватную группу
// несёт числовой id (`t.me/c/2263563987/42`), а на публичную — только имя
// (`t.me/atprojects/42`). Знать одну сторону и получить другую неоткуда: бота
// добавляют в Телеграме, и до первого сообщения кокпит о чате не знает ничего.
import { constants } from 'node:fs';
import {
  lstat, readFile, mkdir, open, rename, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteTelegramJson } from './account-bindings.js';

const KINDS = ['bug', 'wish'];
const DRAFTS = ['manual', 'auto'];
// Имя чата: 5–32 знака, начинается с буквы — правило Телеграма (см. links.js).
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

// Автомат «услышал жалобу → завёл задачу». Выключен по умолчанию и настраивается
// у КАЖДОГО правила отдельно: «Баги от пользователей» имеет смысл отдать автомату
// целиком, а «Идеи и пожелания» — оставить на кнопке, потому что там половина
// сообщений это разговор, а не постановка.
const AUTO_TASK = {
  enabled: false,
  // Порог уверенности разбора и дневной потолок задач: ошибаться автомат обязан
  // в сторону человека, поэтому неуверенный разбор оставляет повод во «Входящих»,
  // а потолок не даёт залить портал за одну ночь.
  minConfidence: 0.7,
  maxPerDay: 10,
};

const AUTO_LAUNCH = {
  enabled: false,
  route: '',
  // Порог уверенности разбора, дневной потолок задач и окно вето: дефолты
  // осторожные намеренно — правило, включённое «посмотреть, что будет», не
  // должно за ночь наделать задач и запусков.
  minConfidence: 0.8,
  maxPerDay: 3,
  vetoMinutes: 10,
};

const isFilled = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/** Целое число из формы (там всё строки); мусор и пустота — null. */
function toInt(v) {
  if (!isFilled(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Номер темы форума; `0` и пустота означают «весь чат», а не тему номер ноль. */
function toThread(v) {
  const n = toInt(v);
  return n && n > 0 ? n : null;
}

/** Имя чата в сравнимом виде: без «собаки», в нижнем регистре. */
function toUsername(v) {
  if (!isFilled(v)) return null;
  return String(v).trim().replace(/^@/, '').toLowerCase();
}

// Число в границах; «не задано» — это дефолт, а не ноль. Разница не косметическая:
// поля приходят из формы строками, очищенное поле приезжает пустой строкой, а
// `Number('')` — ноль. Нулевой порог уверенности означал бы «заводи задачу по
// любому разбору», нулевое окно вето — «запускай немедленно»: стёртое поле не
// имеет права ослаблять автомат.
const clamp = (v, lo, hi, def) => {
  if (!isFilled(v)) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};

function normalizeB24(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const priority = toInt(src.priority);
  return {
    responsibleId: toInt(src.responsibleId),
    groupId: toInt(src.groupId),
    // 0 низкий, 1 средний, 2 высокий — коды портала (docs/cockpit/b24.md).
    priority: [0, 1, 2].includes(priority) ? priority : 1,
  };
}

function normalizeAutoTask(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!src.enabled,
    minConfidence: clamp(src.minConfidence, 0, 1, AUTO_TASK.minConfidence),
    maxPerDay: Math.round(clamp(src.maxPerDay, 0, 100, AUTO_TASK.maxPerDay)),
  };
}

function normalizeAutoLaunch(raw, where) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    enabled: !!src.enabled,
    route: isFilled(src.route) ? String(src.route).trim() : '',
    minConfidence: clamp(src.minConfidence, 0, 1, AUTO_LAUNCH.minConfidence),
    maxPerDay: Math.round(clamp(src.maxPerDay, 0, 100, AUTO_LAUNCH.maxPerDay)),
    vetoMinutes: Math.round(clamp(src.vetoMinutes, 0, 24 * 60, AUTO_LAUNCH.vetoMinutes)),
  };
  if (out.enabled && !out.route) {
    throw new Error(`${where}: автозапуск включён, но маршрут не выбран — запускать нечего.`);
  }
  return out;
}

/**
 * Список правил из формы → то, что можно положить на диск. Бросает `Error` с
 * человеческим текстом: он уезжает прямо в интерфейс, поэтому в нём всегда есть
 * номер правила — в списке из десяти иначе не найти, о каком речь.
 *
 * @param {Array<object>} list правила как их прислал клиент
 * @param {{projects?: string[]}} [opts] известные проекты — если переданы, id сверяется
 */
export function normalizeRules(list, { projects = null } = {}) {
  if (!Array.isArray(list)) throw new Error('Правила должны приходить списком.');
  const known = Array.isArray(projects) && projects.length ? new Set(projects) : null;
  const seen = new Map(); // ключ адреса → номер правила, которое его заняло

  return list.map((raw, i) => {
    const where = `Правило ${i + 1}`;
    const src = raw && typeof raw === 'object' ? raw : {};

    const project = isFilled(src.project) ? String(src.project).trim() : '';
    if (!project) throw new Error(`${where}: не выбран проект.`);
    if (known && !known.has(project)) throw new Error(`${where}: проект «${project}» не найден.`);

    const chatId = toInt(src.chatId);
    const username = toUsername(src.username);
    if (chatId === null && !username) {
      throw new Error(`${where}: не выбран чат — нужен его id или имя.`);
    }
    if (username && !USERNAME_RE.test(username)) {
      throw new Error(`${where}: «${username}» не похоже на имя чата — это 5–32 знака, начиная с буквы.`);
    }

    const kind = isFilled(src.kind) ? String(src.kind).trim() : KINDS[0];
    if (!KINDS.includes(kind)) {
      throw new Error(`${where}: вид «${kind}» неизвестен — бывает ${KINDS.join(' или ')}.`);
    }
    const draft = isFilled(src.draft) ? String(src.draft).trim() : DRAFTS[0];
    if (!DRAFTS.includes(draft)) {
      throw new Error(`${where}: режим черновика «${draft}» неизвестен — бывает ${DRAFTS.join(' или ')}.`);
    }

    const threadId = toThread(src.threadId);
    // Один адрес — одно правило: два правила на одну пару «чат + тема» означали бы,
    // что решает порядок строк в файле, а человек этого порядка не видит.
    for (const side of [chatId, username]) {
      if (side === null) continue;
      const key = `${side}:${threadId ?? ''}`;
      const busy = seen.get(key);
      if (busy) {
        const what = threadId ? `тема ${threadId} чата ${side}` : `чат ${side}`;
        throw new Error(`${where}: ${what} уже привязан (правило ${busy}). Один адрес — одно правило.`);
      }
      seen.set(key, i + 1);
    }

    return {
      project,
      chatId,
      username,
      // Подпись чата — косметика для списка правил: бота могут убрать из чата, и
      // тогда имени взять будет негде, а правило останется.
      title: isFilled(src.title) ? String(src.title).trim() : '',
      threadId,
      kind,
      b24: normalizeB24(src.b24),
      draft,
      // Ответ в исходный чат — явный opt-in каждого правила. Старые правила
      // остаются молчащими, а настройка темы не расползается на соседние темы.
      notifyTaskCreated: src.notifyTaskCreated === true,
      autoTask: normalizeAutoTask(src.autoTask),
      autoLaunch: normalizeAutoLaunch(src.autoLaunch, where),
    };
  });
}

/** Про этот ли чат правило: совпасть достаточно любой известной стороне адреса. */
function sameChat(rule, chatId, username) {
  if (chatId !== null && rule.chatId !== null && rule.chatId === chatId) return true;
  return Boolean(username && rule.username && rule.username === username);
}

/**
 * Правило для конкретного сообщения — или `null`, если чат не привязан.
 *
 * Правило темы сильнее общего правила чата и НЕ распространяется на соседние
 * темы: тема форума — это отдельное обсуждение, и привязка «баги фронта» не
 * должна разрешать чтение темы «зарплаты» того же чата.
 *
 * @param {Array<object>} rules нормализованные правила
 * @param {{chatId?: number|string|null, username?: string|null, threadId?: number|null}} target
 */
export function matchRule(rules, target = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const chatId = toInt(target.chatId);
  const username = toUsername(target.username);
  if (chatId === null && !username) return null;

  const mine = list.filter((r) => sameChat(r, chatId, username));
  if (!mine.length) return null;

  const threadId = toThread(target.threadId);
  if (threadId !== null) {
    const exact = mine.find((r) => r.threadId === threadId);
    if (exact) return exact;
  }
  return mine.find((r) => r.threadId === null) || null;
}

export class TelegramRulesStore {
  /**
   * @param {{dir: string, log?: object, strictRead?: boolean}} opts
   * `strictRead` используется account-aware Inbox: битый allowlist обязан
   * деградировать канал, а не выглядеть как осознанно пустой список.
   */
  constructor({ dir, log = console, strictRead = false }) {
    this.file = path.join(dir, 'rules.json');
    this.log = log;
    this.strictRead = strictRead === true;
    this.cache = null;
    this.stamp = ''; // отпечаток файла, по которому решаем, перечитывать ли
  }

  /** Правила с диска. Файла нет — пустой список: это «ничего не привязано», не ошибка. */
  async read() {
    if (this.strictRead) return this._readStrict();
    let info;
    try {
      info = await stat(this.file);
    } catch (err) {
      if (err?.code !== 'ENOENT' && this.strictRead) {
        throw Object.assign(new Error('Telegram allowlist metadata нельзя прочитать.', { cause: err }), {
          code: 'telegram_rules_invalid',
        });
      }
      this.cache = [];
      this.stamp = '';
      return this.cache;
    }

    // Кэш в памяти, но с проверкой отпечатка: правила правят и руками в файле,
    // а перечитывать крошечный json на каждый резолв ссылки незачем.
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (this.cache && stamp === this.stamp) return this.cache;

    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.cache = normalizeRules(Array.isArray(data) ? data : (data.rules || []));
    } catch (err) {
      // Битый файл НЕ стираем и не чиним догадками: это данные человека. Раздел
      // покажет пустой список, правила вернутся, как только файл починят.
      this.log.warn?.({ err: err.message, file: this.file }, 'телеграм: правила не прочитались');
      if (this.strictRead) {
        throw Object.assign(new Error('Telegram allowlist нельзя безопасно прочитать.', { cause: err }), {
          code: 'telegram_rules_invalid',
        });
      }
      this.cache = [];
    }
    this.stamp = stamp;
    return this.cache;
  }

  /**
   * Сохраняет весь список целиком (редактор правил присылает его так же).
   * Проверка идёт ДО записи: отказ не имеет права испортить уже сохранённое.
   */
  async write(rules, opts = {}) {
    const clean = normalizeRules(rules, opts);
    const body = { updatedAt: Date.now(), rules: clean };
    if (this.strictRead) {
      await atomicWriteTelegramJson(this.file, body);
    } else {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      await rename(tmp, this.file);
    }
    this.cache = clean;
    try {
      const info = await stat(this.file);
      this.stamp = this.strictRead
        ? `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`
        : `${info.mtimeMs}:${info.size}`;
    } catch {
      this.stamp = '';
    }
    return clean;
  }

  /** Разрешено ли читать это сообщение и по чьему правилу. */
  async ruleFor(target) {
    return matchRule(await this.read(), target);
  }

  async _readStrict() {
    let atPath;
    try { atPath = await lstat(this.file); } catch (err) {
      if (err?.code === 'ENOENT') {
        this.cache = [];
        this.stamp = '';
        return this.cache;
      }
      throw Object.assign(new Error('Telegram allowlist metadata нельзя прочитать.', { cause: err }), {
        code: 'telegram_rules_invalid',
      });
    }
    if (atPath.isSymbolicLink() || !atPath.isFile() || atPath.size > 16 * 1024 * 1024) {
      throw Object.assign(new Error('Telegram allowlist не является безопасным обычным файлом.'), {
        code: 'telegram_rules_invalid',
      });
    }
    const stamp = `${atPath.dev}:${atPath.ino}:${atPath.mtimeMs}:${atPath.size}`;
    if (this.cache && stamp === this.stamp) return this.cache;

    let handle;
    try {
      handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat();
      const bytes = await handle.readFile();
      const [after, current] = await Promise.all([handle.stat(), lstat(this.file)]);
      if (!before.isFile() || current.isSymbolicLink() || !current.isFile()
          || before.dev !== after.dev || before.ino !== after.ino
          || after.dev !== current.dev || after.ino !== current.ino
          || before.size !== after.size || after.size !== current.size
          || before.mtimeMs !== after.mtimeMs || after.mtimeMs !== current.mtimeMs
          || bytes.length !== after.size) {
        throw new Error('allowlist изменился во время чтения');
      }
      const data = JSON.parse(bytes.toString('utf8'));
      this.cache = normalizeRules(Array.isArray(data) ? data : data.rules);
      this.stamp = stamp;
      return this.cache;
    } catch (err) {
      this.log.warn?.({ err: err.message, file: this.file }, 'телеграм: правила не прочитались строго');
      throw Object.assign(new Error('Telegram allowlist нельзя безопасно прочитать.', { cause: err }), {
        code: 'telegram_rules_invalid',
      });
    } finally {
      await handle?.close();
    }
  }
}
