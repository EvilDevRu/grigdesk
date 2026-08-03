// Распределитель слотов стенда: кокпит выдаёт индекс ДО запуска конвейера.
//
// ЗАЧЕМ. Стенд задачи занимает «слот» — индекс k, из которого считаются порты (API, FE,
// reverb, xdebug), IP контейнера и номер базы redis. Индекс выбирается ВНУТРИ подъёма
// стенда, а в реестр песочниц (t<TASK>.env) попадает только в самом конце — после
// клонирования БД, минут через двадцать. Всё это время слот ничем не занят: следующий
// запуск видит его свободным и берёт тот же самый.
//
// Два параллельных запуска могут получить один k, а значит одинаковые порты и IP.
// Первый успевает занять их, второй после долгого провижининга умирает на
// `docker compose up` с «Address already in use» — и конвейер встаёт совсем.
//
// Кокпит — единственная точка запуска на машине, поэтому распределение живёт здесь:
// под локом он спрашивает у фабрики занятость, выбирает свободный индекс, записывает
// резервацию и передаёт индекс запускаемому конвейеру (FACTORY_SB_K). Окно между
// «выбрал» и «застолбил» схлопывается до одной файловой операции.
//
// Резервация — МОСТИК, а не источник правды: она нужна ровно до того момента, когда
// подъём допишет SB_K в реестр песочниц. Дальше занятость видна фабрике самой, и
// резервация снимается (по факту передачи или по TTL, если подъём не дожил).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Сколько живёт резервация без подтверждения из реестра песочниц (подъём идёт ~20–25 мин). */
export const RESERVATION_TTL_MS = 45 * 60 * 1000;

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

/** Слотов нет вовсе — отдельный класс, чтобы роут ответил 409, а не 500. */
export class SlotsFullError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SlotsFullError';
    this.details = details;
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function slotsDir(stateDir) {
  const dir = path.join(stateDir, 'slots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Взаимное исключение на каталоге: mkdir атомарен на всех ФС, лишних зависимостей не тянет.
 * Лок, оставшийся от убитого процесса, ломается по возрасту — иначе одна смерть кокпита
 * заблокировала бы запуск конвейеров навсегда.
 */
async function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = Infinity; }
      if (age > LOCK_STALE_MS) { try { fs.rmdirSync(lock); } catch { /* успел другой */ } continue; }
      if (Date.now() > deadline) throw new Error('распределитель слотов занят дольше 10с — попробуй ещё раз');
      await sleep(50);
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(lock); } catch { /* уже снят */ } }
}

/** Один опрос профиля: занятость глазами конкретного каталога состояния. */
function slotsSnapshot({
  factoryBin, stateDir, profilesDir, profile,
}) {
  return new Promise((resolve, reject) => {
    execFile(
      factoryBin, ['slots', '--profile', profile],
      {
        env: {
          ...process.env,
          STATE_DIR: stateDir,
          ...(profilesDir ? { FACTORY_PROFILES_DIR: profilesDir } : {}),
        },
        timeout: 20000,
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        // Профиль без хука слотов — не авария: распределять просто нечего.
        if (err && !out) return reject(new Error((stderr || err.message || '').trim().slice(-400) || 'factory slots не ответил'));
        let parsed;
        try { parsed = JSON.parse(out); } catch { return reject(new Error(`factory slots вернул не JSON: ${out.slice(0, 200)}`)); }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve(parsed);
      },
    );
  });
}

/**
 * Занятость слотов ГЛАЗАМИ ФАБРИКИ (`factory slots --profile <name>`).
 * Считает её профиль тем же кодом, которым подъём стенда выбирает индекс, — иначе
 * распределитель выдал бы резервацию на слот, который up.sh считает занятым.
 *
 * @returns {Promise<{range:[number,number], used:Array<{k:number,by:string,why:string}>, free:number[]}>}
 */
export async function listSlots({
  factoryBin, stateDir, profilesDir = '', profile,
}) {
  return slotsSnapshot({ factoryBin, stateDir, profilesDir, profile });
}

/** Живые резервации: {task → {task, k, at}}. Протухшие подчищаются на месте. */
function readReservations(dir, ttlMs = RESERVATION_TTL_MS) {
  const live = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return live; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rec = null; }
    // Битый или просроченный файл резервации не должен держать слот вечно.
    if (!rec || typeof rec.k !== 'number' || !rec.task || !(Date.now() - (rec.at || 0) < ttlMs)) {
      try { fs.unlinkSync(file); } catch { /* уже удалён */ }
      continue;
    }
    live.set(String(rec.task), rec);
  }
  return live;
}

/**
 * Зарезервировать слот под задачу. Идемпотентно: повторный запуск той же задачи
 * получает свою же резервацию, а не второй слот.
 *
 * Резервация, которую фабрика уже подтвердила (задача числится за слотом в реестре
 * песочниц), снимается: мостик отработал, дальше занятость видна фабрике самой.
 *
 * @returns {Promise<{k:number|null, source:'none'|'registry'|'reservation'|'new', reason?:string}>}
 *          k=null (source='none') — профиль не умеет слоты, запускать как раньше;
 *          source='registry' — стенд уже поднят и слот за ним закреплён, подсказывать нечего.
 * @throws {SlotsFullError} свободных слотов нет
 */
export async function reserveSlot({
  factoryBin, stateDir, profilesDir = '', profile, task, ttlMs = RESERVATION_TTL_MS,
}) {
  // Резервации и runtime-проекция принадлежат одному state root.
  const dir = slotsDir(stateDir);
  const slots = await listSlots({ factoryBin, stateDir, profilesDir, profile });
  // Отсутствие slot contract должно быть явным успешным ответом движка. Ошибку/битый
  // JSON больше не превращаем в запуск без резервации: это возвращало гонку портов.
  if (slots?.supported === false) {
    return { k: null, source: 'none', reason: slots.reason || 'профиль не использует слоты' };
  }

  return withLock(dir, async () => {
    const reserved = readReservations(dir, ttlMs);
    const key = String(task);

    // Слот уже за этой задачей в реестре песочниц — резервация больше не нужна.
    const claimedByTask = (slots.used || []).find((u) => String(u.by || '').split(',').includes(key));
    if (claimedByTask) {
      if (reserved.has(key)) { try { fs.unlinkSync(path.join(dir, `t${key}.json`)); } catch { /* нет файла */ } }
      return { k: claimedByTask.k, source: 'registry', reason: 'слот уже закреплён за задачей в реестре песочниц' };
    }

    const mine = reserved.get(key);
    if (mine) return { k: mine.k, source: 'reservation', reason: 'резервация этой задачи ещё жива' };

    const takenByOthers = new Set([...reserved.values()].map((r) => r.k));
    const free = (slots.free || []).filter((k) => !takenByOthers.has(k));
    if (!free.length) {
      const holders = [
        ...(slots.used || []).map((u) => `k=${u.k} — ${u.why === 'task' ? `задача #${u.by}` : u.why === 'ip' ? 'занят IP' : 'занят порт'}`),
        ...[...reserved.values()].map((r) => `k=${r.k} — резерв под #${r.task}`),
      ];
      throw new SlotsFullError(
        `нет свободного слота стенда (${slots.range?.[0] ?? 0}..${slots.range?.[1] ?? 0}): ${holders.join('; ')}`,
        { range: slots.range, used: slots.used, reserved: [...reserved.values()] },
      );
    }

    const k = Math.min(...free);
    const rec = { task: key, k, at: Date.now() };
    // Запись через временный файл + rename: под локом это перестраховка, но резервация —
    // единственное, что стоит между двумя конвейерами и общим портом.
    const tmp = path.join(dir, `.t${key}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec), 'utf8');
    fs.renameSync(tmp, path.join(dir, `t${key}.json`));
    return { k, source: 'new' };
  });
}

/** Снять резервацию задачи (запуск не удался, стенд снесён, слот отдан фабрике). */
export function releaseSlot({ stateDir, task }) {
  try { fs.unlinkSync(path.join(slotsDir(stateDir), `t${String(task)}.json`)); } catch { /* нечего снимать */ }
}

/** Занятость + резервации одним ответом — для диагностики и UI. */
export async function slotsOverview({
  factoryBin, stateDir, profilesDir = '', profile,
}) {
  const dir = slotsDir(stateDir);
  const reserved = [...readReservations(dir).values()];
  try {
    const slots = await listSlots({
      factoryBin, stateDir, profilesDir, profile,
    });
    const takenByOthers = new Set(reserved.map((r) => r.k));
    return { ...slots, reserved, free: (slots.free || []).filter((k) => !takenByOthers.has(k)) };
  } catch (e) {
    return { error: e.message, reserved };
  }
}
