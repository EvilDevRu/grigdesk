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
//     agentSearch: boolean,
//     autoTask: { enabled, minConfidence, maxPerDay },
//     autoLaunch: { enabled, route, minConfidence, maxPerDay, vetoMinutes } }
//
// Адрес чата хранится ДВУМЯ сторонами, и обе нужны: ссылка на приватную группу
// несёт синтетический числовой id (`t.me/c/1000000042/42`), а на публичную — только имя
// (`t.me/example_team/42`). Знать одну сторону и получить другую неоткуда: бота
// добавляют в Телеграме, и до первого сообщения кокпит о чате не знает ничего.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat, readFile, mkdir, open, realpath, rename, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { assertAccountRef } from '../inbox/identity.js';
import {
  atomicWriteTelegramJson,
  normalizeTelegramBotId,
} from './account-bindings.js';

const KINDS = ['bug', 'wish'];
const DRAFTS = ['manual', 'auto'];
// Имя чата: 5–32 знака, начинается с буквы — правило Телеграма (см. links.js).
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;
const POLICY_FINGERPRINT_PREFIX = 'telegram-rules-v1:';
const POLICY_FINGERPRINT_RE = /^telegram-rules-v1:[0-9a-f]{64}$/u;
const AGENT_SEARCH_TARGET_KEYS = ['project', 'chatId', 'username', 'threadId'];
const OWNER_BOUND_SCHEMA_VERSION = 2;
const MAX_RULES_BYTES = 1024 * 1024;
const OWNER_BOUND_KEYS = [
  'schemaVersion', 'channel', 'accountRef', 'botId', 'updatedAtMs', 'rules',
];
const STORE_QUEUES = new Map();

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

// JSON.stringify сохраняет порядок ключей входного объекта, поэтому сам по себе
// не годится как canonical policy encoding: ручная перестановка полей не должна
// менять CAS. Нормализация выше убирает неизвестные поля, а эта функция
// рекурсивно фиксирует порядок известных ключей.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const clone = (value) => structuredClone(value);

/**
 * Отпечаток всей нормализованной policy правила. Это честный CAS/fingerprint,
 * но НЕ scope fence и НЕ монотонная epoch: эти механизмы добавляет search
 * control-plane отдельно, когда сможет дренировать уже начатые ответы.
 */
export function telegramRulesPolicyFingerprint(rules, { accountRef = null } = {}) {
  const owner = accountRef === null ? null : assertAccountRef(accountRef);
  const canonical = canonicalJson({
    accountRef: owner,
    channel: 'telegram',
    rules: normalizeRules(rules),
    schemaVersion: 1,
  });
  return `${POLICY_FINGERPRINT_PREFIX}${createHash('sha256').update(canonical).digest('hex')}`;
}

export function isTelegramRulesPolicyFingerprint(value) {
  return typeof value === 'string' && POLICY_FINGERPRINT_RE.test(value);
}

function codedError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function legacyRulesDocument(data) {
  if (Array.isArray(data)) return data;
  if (isPlainObject(data) && !Object.hasOwn(data, 'schemaVersion') && Array.isArray(data.rules)) {
    return data.rules;
  }
  throw new Error('Telegram rules не соответствуют legacy либо owner-bound schema.');
}

function ownerBoundRulesDocument(data, { accountRef, botId }) {
  if (!exactObject(data, OWNER_BOUND_KEYS)
      || data.schemaVersion !== OWNER_BOUND_SCHEMA_VERSION
      || data.channel !== 'telegram'
      || data.accountRef !== accountRef
      || typeof data.botId !== 'string'
      || normalizeTelegramBotId(data.botId, 'rules.botId') !== botId
      || !Number.isSafeInteger(data.updatedAtMs)
      || data.updatedAtMs <= 0
      || !Array.isArray(data.rules)) {
    throw new Error('Telegram rules owner/schema не совпадает с активным account.');
  }
  return data.rules;
}

// Persisted v2 — не form input. Он обязан быть уже canonical до байта semantics:
// coercion строк/массивов и truthy "false" здесь означают corruption, а не удобство.
function normalizeStoredRules(rawRules) {
  const normalized = normalizeRules(rawRules);
  if (canonicalJson(rawRules) !== canonicalJson(normalized)) {
    throw new Error('Telegram rules v2 содержит неканоническое внутреннее правило.');
  }
  return normalized;
}

function canonicalSubset(raw, normalized) {
  if (Array.isArray(raw)) {
    return Array.isArray(normalized)
      && raw.length === normalized.length
      && raw.every((item, index) => canonicalSubset(item, normalized[index]));
  }
  if (isPlainObject(raw)) {
    return isPlainObject(normalized)
      && Object.keys(raw).every((key) => (
        Object.hasOwn(normalized, key) && canonicalSubset(raw[key], normalized[key])
      ));
  }
  return Object.is(raw, normalized);
}

function normalizeLegacyStoredRules(rawRules) {
  const normalized = normalizeRules(rawRules);
  if (!rawRules.every((rule, index) => canonicalSubset(rule, normalized[index]))) {
    throw new Error('Legacy Telegram rules содержит неканоническое значение поля.');
  }
  return normalized.map((rule) => ({ ...rule, agentSearch: false }));
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.nlink === right.nlink;
}

async function assertExistingPathComponentsNoSymlink(directory) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Путь Telegram rules содержит небезопасный component.');
    }
  }
}

async function openStrictDirectory(directory) {
  const resolved = path.resolve(directory);
  await assertExistingPathComponentsNoSymlink(resolved);
  let canonical;
  try { canonical = await realpath(resolved); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (canonical !== resolved) throw new Error('Каталог Telegram rules содержит symlink component.');
  const atPath = await lstat(resolved);
  if (atPath.isSymbolicLink() || !atPath.isDirectory()) {
    throw new Error('Каталог Telegram rules небезопасен.');
  }
  const handle = await open(
    resolved,
    constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== atPath.dev || opened.ino !== atPath.ino) {
      throw new Error('Каталог Telegram rules изменился во время открытия.');
    }
    return { handle, resolved, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertStrictDirectoryStable(directory) {
  const [opened, atPath, canonical] = await Promise.all([
    directory.handle.stat(),
    lstat(directory.resolved),
    realpath(directory.resolved),
  ]);
  if (canonical !== directory.resolved
      || atPath.isSymbolicLink() || !atPath.isDirectory() || !opened.isDirectory()
      || opened.dev !== directory.dev || opened.ino !== directory.ino
      || atPath.dev !== directory.dev || atPath.ino !== directory.ino) {
    throw new Error('Каталог Telegram rules изменился во время чтения.');
  }
}

function staleRules(message = 'Telegram rules изменились после загрузки формы.') {
  throw codedError('telegram_rules_stale', message, 409);
}

function policyScopeKey(rule) {
  return canonicalJson({
    project: rule.project,
    chatId: rule.chatId,
    username: rule.username,
    threadId: rule.threadId,
  });
}

function normalizeAgentSearchTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw codedError('telegram_rules_invalid', 'agentSearch.rule должен быть объектом.', 400);
  }
  const actual = Object.keys(raw).sort();
  const expected = [...AGENT_SEARCH_TARGET_KEYS].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw codedError('telegram_rules_invalid', 'agentSearch.rule имеет неверные поля.', 400);
  }
  const [rule] = normalizeRules([raw]);
  return {
    project: rule.project,
    chatId: rule.chatId,
    username: rule.username,
    threadId: rule.threadId,
  };
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
      // Human allowlist задаёт само наличие правила. Будущий внешний корпус
      // переписки шире не выводим из него: локальная SQLite-база знаний этим
      // флагом не управляется, а внешний текст требует отдельного opt-in.
      agentSearch: src.agentSearch === true,
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
   * @param {{dir: string, accountRef?: string|null, botId?: string|number|null,
   *   log?: object, strictRead?: boolean}} opts
   * `strictRead` используется account-aware Inbox: битый allowlist обязан
   * деградировать канал, а не выглядеть как осознанно пустой список.
   */
  constructor({
    dir,
    accountRef = null,
    botId = null,
    log = console,
    strictRead = false,
  }) {
    this.file = path.join(dir, 'rules.json');
    this.log = log;
    this.strictRead = strictRead === true;
    if (this.strictRead && (accountRef === null || botId === null)) {
      throw new TypeError('Strict TelegramRulesStore требует accountRef и botId владельца policy.');
    }
    this.accountRef = accountRef === null ? null : assertAccountRef(accountRef);
    this.botId = botId === null ? null : normalizeTelegramBotId(botId, 'rules owner botId');
    this.cache = null;
    // Legacy rules не доказывают владельца файла. Human allowlist продолжает
    // работать, но agentSearch на чтении принудительно закрывается до явного CAS,
    // который перепишет policy в owner-bound schema v2.
    this.ownerBound = this.strictRead;
    this.stamp = ''; // отпечаток файла, по которому решаем, перечитывать ли
    this.queueKey = path.resolve(this.file);
  }

  _queued(operation) {
    // Очередь общая для всех экземпляров того же physical store в процессе.
    // Durable epoch/cross-process owner остаются отдельным release gate, но два
    // overlapping account contexts уже не проходят один stale CAS одновременно.
    const previous = STORE_QUEUES.get(this.queueKey) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => {});
    STORE_QUEUES.set(this.queueKey, tail);
    tail.then(() => {
      if (STORE_QUEUES.get(this.queueKey) === tail) STORE_QUEUES.delete(this.queueKey);
    });
    return result;
  }

  /** Правила с диска. Файла нет — пустой список: это «ничего не привязано», не ошибка. */
  async read() {
    if (this.strictRead) return clone(await this._readStrict());
    let info;
    try {
      info = await stat(this.file);
    } catch (err) {
      if (err?.code !== 'ENOENT' && this.strictRead) {
        throw Object.assign(new Error('Telegram allowlist metadata нельзя прочитать.', { cause: err }), {
          code: 'telegram_rules_invalid',
        });
      }
      this.cache = deepFreeze([]);
      this.ownerBound = this.strictRead;
      this.stamp = '';
      return clone(this.cache);
    }

    // Кэш в памяти, но с проверкой отпечатка: правила правят и руками в файле,
    // а перечитывать крошечный json на каждый резолв ссылки незачем.
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (this.cache && stamp === this.stamp) return clone(this.cache);

    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.cache = deepFreeze(normalizeRules(Array.isArray(data) ? data : (data.rules || [])));
      this.ownerBound = false;
    } catch (err) {
      // Битый файл НЕ стираем и не чиним догадками: это данные человека. Раздел
      // покажет пустой список, правила вернутся, как только файл починят.
      this.log.warn?.({ err: err.message, file: this.file }, 'телеграм: правила не прочитались');
      if (this.strictRead) {
        throw Object.assign(new Error('Telegram allowlist нельзя безопасно прочитать.', { cause: err }), {
          code: 'telegram_rules_invalid',
        });
      }
      this.cache = deepFreeze([]);
      this.ownerBound = false;
    }
    this.stamp = stamp;
    return clone(this.cache);
  }

  _policy(rules) {
    return {
      rules: clone(rules),
      policyFingerprint: telegramRulesPolicyFingerprint(rules, { accountRef: this.accountRef }),
      ownerBound: this.ownerBound,
    };
  }

  /** Authoritative rules + canonical CAS, вычисленный из прочитанного store. */
  async readPolicySnapshot() {
    return this._policy(await this.read());
  }

  async _writeClean(clean) {
    const nowMs = Date.now();
    const body = this.strictRead
      ? {
          schemaVersion: OWNER_BOUND_SCHEMA_VERSION,
          channel: 'telegram',
          accountRef: this.accountRef,
          botId: this.botId,
          updatedAtMs: nowMs,
          rules: clean,
        }
      : { updatedAt: nowMs, rules: clean };
    if (this.strictRead) {
      const beforeDirectory = await openStrictDirectory(path.dirname(this.file));
      await beforeDirectory?.handle.close();
      await atomicWriteTelegramJson(this.file, body);
      const afterDirectory = await openStrictDirectory(path.dirname(this.file));
      if (!afterDirectory) throw new Error('Каталог Telegram rules исчез после записи.');
      await afterDirectory.handle.close();
    } else {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      await rename(tmp, this.file);
    }
    this.cache = deepFreeze(clone(clean));
    this.ownerBound = this.strictRead;
    try {
      const info = await stat(this.file);
      this.stamp = this.strictRead
        ? `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`
        : `${info.mtimeMs}:${info.size}`;
    } catch {
      this.stamp = '';
    }
    return clone(this.cache);
  }

  /**
   * Сохраняет весь список целиком для доверенного внутреннего writer-а.
   * HTTP/UI обязан использовать `writeHumanCas`/`setAgentSearch`, а не этот
   * служебный путь начальной настройки и тестов.
   * Проверка идёт ДО записи: отказ не имеет права испортить уже сохранённое.
   */
  async write(rules, opts = {}) {
    const clean = normalizeRules(rules, opts);
    return this._queued(() => this._writeClean(clean));
  }

  /**
   * Обычный редактор human allowlist. Он не владеет agentSearch: поле во входе
   * запрещено, а прежний opt-in сохраняется только у exact того же scope.
   */
  async writeHumanCas(rules, { expectedPolicyFingerprint, projects = null } = {}) {
    if (!isTelegramRulesPolicyFingerprint(expectedPolicyFingerprint)) {
      throw codedError('telegram_rules_invalid', 'Telegram rules CAS fingerprint имеет неверный формат.', 400);
    }
    if (Array.isArray(rules) && rules.some((rule) => (
      rule && typeof rule === 'object' && Object.hasOwn(rule, 'agentSearch')
    ))) {
      throw codedError(
        'telegram_rules_invalid',
        'agentSearch меняется только отдельной CAS-операцией.',
        400,
      );
    }
    const clean = normalizeRules(rules, { projects });
    return this._queued(async () => {
      const current = await this.readPolicySnapshot();
      if (current.policyFingerprint !== expectedPolicyFingerprint) {
        staleRules();
      }
      const previous = new Map(current.rules.map((rule) => [policyScopeKey(rule), rule]));
      const next = clean.map((rule) => ({
        ...rule,
        agentSearch: previous.get(policyScopeKey(rule))?.agentSearch === true,
      }));
      return this._policy(await this._writeClean(next));
    });
  }

  /** Отдельный opt-in/out exact Telegram rule, всегда под policy CAS. */
  async setAgentSearch({ rule, enabled, expectedPolicyFingerprint } = {}) {
    if (typeof enabled !== 'boolean') {
      throw codedError('telegram_rules_invalid', 'agentSearch.enabled должен быть boolean.', 400);
    }
    if (!isTelegramRulesPolicyFingerprint(expectedPolicyFingerprint)) {
      throw codedError('telegram_rules_invalid', 'Telegram rules CAS fingerprint имеет неверный формат.', 400);
    }
    const target = normalizeAgentSearchTarget(rule);
    return this._queued(async () => {
      const current = await this.readPolicySnapshot();
      if (current.policyFingerprint !== expectedPolicyFingerprint) staleRules();
      const targetKey = policyScopeKey(target);
      const index = current.rules.findIndex((candidate) => policyScopeKey(candidate) === targetKey);
      if (index < 0) staleRules('Telegram rule для agentSearch больше не существует.');
      if (current.rules[index].agentSearch === enabled) return current;
      const next = current.rules.map((candidate, position) => (
        position === index ? { ...candidate, agentSearch: enabled } : candidate
      ));
      return this._policy(await this._writeClean(next));
    });
  }

  /** Разрешено ли читать это сообщение и по чьему правилу. */
  async ruleFor(target) {
    return matchRule(await this.read(), target);
  }

  async _readStrict() {
    let directory;
    let handle;
    try {
      directory = await openStrictDirectory(path.dirname(this.file));
      if (!directory) {
        try {
          await lstat(this.file);
          throw new Error('rules.json существует без стабильного parent directory.');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        this.cache = deepFreeze([]);
        this.ownerBound = true;
        this.stamp = '';
        return this.cache;
      }

      let atPath;
      try { atPath = await lstat(this.file); } catch (error) {
        if (error?.code === 'ENOENT') {
          await assertStrictDirectoryStable(directory);
          this.cache = deepFreeze([]);
          this.ownerBound = true;
          this.stamp = '';
          return this.cache;
        }
        throw error;
      }
      if (atPath.isSymbolicLink() || !atPath.isFile()
          || atPath.nlink !== 1 || atPath.size > MAX_RULES_BYTES) {
        throw new Error('Telegram allowlist не является безопасным single-link файлом.');
      }

      // Открываем basename относительно уже закреплённого directory fd. Если
      // pathname parent подменят, прочитанные bytes всё равно относятся к старому
      // fd, а post-check не даст их опубликовать.
      const anchoredFile = `/proc/self/fd/${directory.handle.fd}/${path.basename(this.file)}`;
      handle = await open(anchoredFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_RULES_BYTES
          || !sameFileSnapshot(before, atPath)) {
        throw new Error('Telegram allowlist identity не совпала при открытии.');
      }
      const bytes = await handle.readFile();
      const [after, current] = await Promise.all([
        handle.stat(),
        lstat(this.file),
        assertStrictDirectoryStable(directory),
      ]);
      if (!before.isFile() || current.isSymbolicLink() || !current.isFile()
          || before.nlink !== 1 || after.nlink !== 1 || current.nlink !== 1
          || !sameFileSnapshot(before, after) || !sameFileSnapshot(after, current)
          || bytes.length !== after.size) {
        throw new Error('allowlist изменился во время чтения');
      }
      const data = JSON.parse(bytes.toString('utf8'));
      const ownerBound = isPlainObject(data) && Object.hasOwn(data, 'schemaVersion');
      const rawRules = ownerBound
        ? ownerBoundRulesDocument(data, { accountRef: this.accountRef, botId: this.botId })
        : legacyRulesDocument(data);
      this.cache = deepFreeze(ownerBound
        ? normalizeStoredRules(rawRules)
        : normalizeLegacyStoredRules(rawRules));
      this.ownerBound = ownerBound;
      this.stamp = `${after.dev}:${after.ino}:${after.ctimeMs}:${after.size}`;
      return this.cache;
    } catch (err) {
      this.log.warn?.({ err: err.message, file: this.file }, 'телеграм: правила не прочитались строго');
      throw Object.assign(new Error('Telegram allowlist нельзя безопасно прочитать.', { cause: err }), {
        code: 'telegram_rules_invalid',
      });
    } finally {
      await handle?.close();
      await directory?.handle.close();
    }
  }
}
