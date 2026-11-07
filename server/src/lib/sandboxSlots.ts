// Распределитель слотов стенда: GrigDesk выдаёт индекс ДО запуска конвейера.
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
// GrigDesk — единственная точка запуска на машине, поэтому распределение живёт здесь:
// под локом он спрашивает у фабрики занятость, выбирает свободный индекс, записывает
// резервацию и передаёт индекс запускаемому конвейеру (FACTORY_SB_K). Окно между
// «выбрал» и «застолбил» схлопывается до одной файловой операции.
//
// Резервация — МОСТИК, а не источник правды: она нужна ровно до того момента, когда
// подъём допишет SB_K в реестр песочниц. Дальше занятость видна фабрике самой, и
// резервация снимается (по факту передачи или по TTL, если подъём не дожил).
import { setTimeout as sleep } from 'node:timers/promises';

import { config as runtimeConfig } from '../config.ts';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Сколько живёт резервация без подтверждения из реестра песочниц (подъём идёт ~20–25 мин). */
export const RESERVATION_TTL_MS = 45 * 60 * 1000;

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

// Занятый слот глазами фабрики: кем и почему (задача, IP или порт).
export interface UsedSlot {
  k: number;
  by: string;
  why: string;
}

// Ответ `factory slots --profile <name>`. Профиль без хука отвечает supported:false.
export interface SlotsSnapshot {
  range?: [number, number];
  used?: UsedSlot[];
  free?: number[];
  supported?: boolean;
  reason?: string;
}

// Резервация: мостик между выбором слота и записью SB_K в реестр песочниц.
export interface SlotReservation {
  task: string;
  k: number;
  at: number;
}

// Что известно про слот после резервирования и откуда это знание.
export interface SlotDecision {
  k: number | null;
  source: 'none' | 'registry' | 'reservation' | 'new';
  reason?: string;
}

// Куда смотреть за занятостью: бинарь фабрики, состояние и профиль.
export interface SlotsScope {
  factoryBin: string;
  stateDir: string;
  profilesDir?: string;
  profile: string;
}

// Что показывает отказ «слотов нет»: диапазон, занятые и живые резервации.
export interface SlotsFullDetails {
  range?: [number, number];
  used?: UsedSlot[];
  reserved: SlotReservation[];
}

/** Слотов нет вовсе — отдельный класс, чтобы роут ответил 409, а не 500. */
export class SlotsFullError extends Error {
  readonly details: SlotsFullDetails;

  constructor(message: string, details: SlotsFullDetails) {
    super(message);
    this.name = 'SlotsFullError';
    this.details = details;
  }
}

function slotsDir(stateDir: string): string {
  const dir = path.join(stateDir, 'slots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Взаимное исключение на каталоге: mkdir атомарен на всех ФС, лишних зависимостей не тянет.
 * Лок, оставшийся от убитого процесса, ломается по возрасту — иначе одна смерть GrigDesk
 * заблокировала бы запуск конвейеров навсегда.
 */
async function withLock<Value>(dir: string, fn: () => Promise<Value>): Promise<Value> {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== 'EEXIST') throw e;
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
}: SlotsScope): Promise<SlotsSnapshot> {
  return new Promise<SlotsSnapshot>((resolve, reject) => {
    execFile(
      factoryBin, ['slots', '--profile', profile],
      {
        env: {
          ...process.env,
          GRIGDESK_HOME: runtimeConfig.dataHome,
          STATE_DIR: stateDir,
          ...(profilesDir ? { FACTORY_PROFILES_DIR: profilesDir } : {}),
        },
        timeout: 20000,
      },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        // Профиль без хука слотов — не авария: распределять просто нечего.
        if (err && !out) return reject(new Error((stderr || err.message || '').trim().slice(-400) || 'factory slots не ответил'));
        let parsed: SlotsSnapshot & { error?: string };
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
 */
export async function listSlots({
  factoryBin, stateDir, profilesDir = '', profile,
}: SlotsScope): Promise<SlotsSnapshot> {
  return slotsSnapshot({ factoryBin, stateDir, profilesDir, profile });
}

/**
 * Номера задач с ЖИВОЙ резервацией. Правило протухания живёт здесь же, поэтому
 * читатель занятости (например, выбор служебного номера песочницы) не заводит
 * своей копии раскладки каталога и своего понимания TTL.
 */
export function reservedTasks(
  { stateDir, ttlMs = RESERVATION_TTL_MS }: { stateDir: string; ttlMs?: number },
): string[] {
  return [...readReservations(slotsDir(stateDir), ttlMs).keys()];
}

/** Живые резервации: {task → {task, k, at}}. Протухшие подчищаются на месте. */
function readReservations(
  dir: string,
  ttlMs = RESERVATION_TTL_MS,
): Map<string, SlotReservation> {
  const live = new Map<string, SlotReservation>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return live; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let rec: SlotReservation | null;
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
 * Сигнал предварительной загрузки, доступный только для чтения, для точной задачи. Пока
 * попытка или реестр ещё не появились, надёжная резервировка доказывает, что другой запуск
 * уже прошёл проверку слота; повторный запуск в это окно запрещён. Просроченная запись
 * очищается тем же кодом, что и сводка.
 */
export function hasSlotReservation({ stateDir, task, ttlMs = RESERVATION_TTL_MS }: {
  stateDir: string;
  task: string | number;
  ttlMs?: number;
}): boolean {
  const id = String(task || '');
  if (!/^[1-9][0-9]{0,18}$/.test(id)) return false;
  return readReservations(slotsDir(stateDir), ttlMs).has(id);
}

/**
 * Зарезервировать слот под задачу. Идемпотентно: повторный запуск той же задачи
 * получает свою же резервацию, а не второй слот.
 *
 * Резервация, которую фабрика уже подтвердила (задача числится за слотом в реестре
 * песочниц), снимается: мостик отработал, дальше занятость видна фабрике самой.
 *
 * k=null (source='none') — профиль не умеет слоты, запускать как раньше;
 * source='registry' — стенд уже поднят и слот за ним закреплён, подсказывать нечего.
 * Нет ни одного свободного слота — SlotsFullError.
 */
export async function reserveSlot({
  factoryBin, stateDir, profilesDir = '', profile, task, ttlMs = RESERVATION_TTL_MS,
}: SlotsScope & { task: string | number; ttlMs?: number }): Promise<SlotDecision> {
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
export function releaseSlot({ stateDir, task }: {
  stateDir: string;
  task: string | number;
}): void {
  try { fs.unlinkSync(path.join(slotsDir(stateDir), `t${String(task)}.json`)); } catch { /* нечего снимать */ }
}

/** Занятость + резервации одним ответом — для диагностики и UI. */
export async function slotsOverview({
  factoryBin, stateDir, profilesDir = '', profile,
}: SlotsScope): Promise<SlotsSnapshot & { reserved: SlotReservation[]; error?: string }> {
  const dir = slotsDir(stateDir);
  const reserved = [...readReservations(dir).values()];
  try {
    const slots = await listSlots({
      factoryBin, stateDir, profilesDir, profile,
    });
    const takenByOthers = new Set(reserved.map((r) => r.k));
    return { ...slots, reserved, free: (slots.free || []).filter((k) => !takenByOthers.has(k)) };
  } catch (e) {
    return { error: (e as Error).message, reserved };
  }
}
