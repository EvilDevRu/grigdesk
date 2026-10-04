// Каталог моделей Claude — БЕЗ хардкода версий: список берётся из самого бинаря CLI.
// Почему так: подпись модели быстро протухает, а алиас `opus` резолвится той версией CLI,
// которая установлена на хосте.
// Единственный источник, всегда совпадающий с реальностью и не требующий ключей/сети, —
// набор идентификаторов, вшитый в установленный бинарь. Имя выводим из id.
//
// Файл начинается с `_` — загрузчик исполнителей его пропускает (это не исполнитель).
import { createReadStream, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';

// claude-opus-5, claude-opus-4-8, claude-sonnet-4-6[1m], claude-fable-5 …
// Минор ограничен двумя цифрами — иначе в улов попадают датированные id
// (claude-opus-4-1-20250805) и версия «4.20250805».
const MODEL_RE = /claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(\[1m\])?(?![\w-])/g;

// РЕЕСТР МОДЕЛЕЙ, вшитый в бинарь: рядом с каждым id лежат окно контекста, подпись,
// потолок вывода и список возможностей. Начало записи:
//   {id:"claude-opus-5",family:"opus",display_name:"Opus 5",…,
//    context:{window:1e6,native_1m:!0,supports_1m_beta:!0,supports_1m_suffix:!0},
//    max_output_tokens:{default:64000,upper:128000},capabilities:["effort",…]}
// Ради этой таблицы скан и затевался заново: раньше окно ВЫВОДИЛОСЬ из имени
// («есть [1m] — миллион, иначе 200k»), и это враньё для всего текущего поколения —
// у Fable 5, Opus 5/4.8/4.7 и Sonnet 5 миллион ВСТРОЕННЫЙ (`native_1m`), без суффикса.
const REGISTRY_RE = /\{id:"(claude-[a-z0-9.-]+)",family:"([a-z0-9-]+)"/g;
// Одна запись реестра укладывается примерно в 2 КБ; берём с запасом, но меньше
// нахлёста чанков (OVERLAP) — иначе запись рвалась бы на границе чтения.
const REGISTRY_ENTRY_MAX = 4096;

/**
 * Выделяет ровно один объект реестра, включая вложенные объекты. Прежний `slice(4096)`
 * позволял отсутствующему полю первой модели «приехать» из следующей записи: например,
 * Opus без `context` получал миллион соседнего Fable и выглядел проверенным.
 *
 * `null` означает, что объект оборван границей чанка или превышает разумный потолок.
 * Благодаря нахлёсту скан увидит короткую оборванную запись ещё раз в следующем чанке;
 * реально незавершённая запись останется без metadata и будет явно помечена ниже.
 */
// Запись реестра моделей внутри бандла CLI: разбирается ровно то, что нужно каталогу.
interface RegistryEntry {
  family?: string;
  displayName: string;
  window: number | null;
  native1m: boolean;
  maxOutput: number | null;
  capabilities: string[] | null;
}

// Модель, узнанная сканом бинаря: семейство и разложенная версия.
interface FoundModel {
  family: string;
  major: string;
  minor: string;
  big: boolean;
}

function registryObjectAt(text: string, start: number): string | null {
  const limit = Math.min(text.length, start + REGISTRY_ENTRY_MAX);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < limit; i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Поля одной записи реестра. Разбираем ровно то, что нужно каталогу, а не весь объект:
 * формат бандла не контракт, и чем меньше мы от него ждём, тем дольше живёт разбор.
 */
function parseRegistryEntry(entry: string): RegistryEntry {
  const ctxAt = entry.indexOf('context:{');
  // Внутри `context` бывает вложенный объект (`native_1m_3p:{…}`), поэтому выделяем
  // его тем же балансировщиком, а не останавливаемся на первой закрывающей скобке.
  const ctx = ctxAt < 0 ? '' : (registryObjectAt(entry, ctxAt + 'context:'.length) || '');
  // Окно принимаем только правдоподобное. Смени бандл запись числа на `1_000_000`
  // (разделители разрядов) — регексп поймал бы «1», и кокпит уверенно показал бы окно
  // в один токен. Молчаливая чушь хуже отказа: непрошедшее значение считается «не знаю».
  // `1e6` в бандле — обычная числовая литера, Number разбирает её сам.
  const raw = Number(/window:(\d+(?:e[+-]?\d+)?)(?=\s*[,}])/i.exec(ctx)?.[1]);
  const out = /max_output_tokens:\{default:(\d+),upper:(\d+)\}/.exec(entry);
  const caps = /capabilities:\[([^\]]*)\]/.exec(entry);
  return {
    displayName: /display_name:"([^"]+)"/.exec(entry)?.[1] || '',
    window: Number.isFinite(raw) && raw >= 1000 ? raw : null,
    // Встроенный миллион (без суффикса `[1m]` и без beta-заголовка).
    native1m: /native_1m:!0/.test(ctx),
    maxOutput: out ? Number(out[2]) : null,
    // `null` отличает сломанный разбор от честного пустого списка возможностей.
    capabilities: caps ? [...String(caps[1]).matchAll(/"([^"]+)"/g)].map((m) => String(m[1])) : null,
  };
}

function oneMillionDisabled() {
  // Тот же bool-диалект, что у CLI: строковые `0`/`false`/`no`/`off` означают false,
  // а не «переменная существует». Иначе каталог расходился бы с фактическим запуском.
  return /^(?:1|true|yes|on)$/i.test(
    String(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT || '').trim(),
  );
}

// OAuth refresh использует публичную пару «token endpoint + client id», встроенную в CLI.
// Ищем их как единый блок рядом с callback: брать id отдельно и подставлять к другому
// endpoint нельзя — refresh token ушёл бы не тому OAuth-клиенту.
const OAUTH_RE = /(https:\/\/[^\x00\s"'<>]+\/oauth\/token)[\s\S]{0,4096}?https:\/\/[^\x00\s"'<>]+\/oauth\/code\/callback[\s\S]{0,512}?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/i;

// Сколько последних версий каждого семейства держать в кратком списке. Одна: в работе нужна
// свежая модель, остальное — за тумблером «показывать все». Вариант [1m] той же версии
// считается формой, а не отдельной версией, и остаётся вместе с ней.
const KEEP_VERSIONS = 1;

// Ранг семейства (сортировка в селекте: сильнее — выше).
const FAMILY_TIER = { opus: 90, fable: 85, sonnet: 70, haiku: 40 };
const FAMILY_NAME = { opus: 'Opus', fable: 'Fable', sonnet: 'Sonnet', haiku: 'Haiku' };

/**
 * Человекочитаемое имя из id: claude-opus-4-8 → «Opus 4.8», claude-opus-5[1m] → «Opus 5 (1M)».
 */
export function modelName(
  family: string,
  major: string | number,
  minor: string | number,
  big: boolean,
): string {
  const ver = minor ? `${major}.${minor}` : String(major);
  const names = FAMILY_NAME as Record<string, string | undefined>;
  return `${names[family] || family} ${ver}${big ? ' (1M)' : ''}`;
}

/**
 * Ранг: семейство × 100 + версия. Вариант [1m] — сразу под своей базовой моделью.
 */
function modelTier(
  family: string,
  major: string | number,
  minor: string | number,
  big: boolean,
): number {
  const tiers = FAMILY_TIER as Record<string, number | undefined>;
  return (tiers[family] || 10) * 100 + Number(major) * 10 + Number(minor || 0) - (big ? 1 : 0);
}

/**
 * Абсолютный путь к бинарю CLI (claudeBin может быть просто именем в PATH).
 */
async function resolveBin(bin: string): Promise<string | null> {
  if (bin.includes(path.sep)) return fs.realpath(bin).catch(() => bin);
  const which = await new Promise<string | null>((resolve) => {
    execFile('which', [bin], { timeout: 5000 }, (err, stdout) => resolve(err ? null : (stdout || '').trim()));
  });
  if (!which) return null;
  return fs.realpath(which).catch(() => which);
}

/**
 * Скан бинаря на известные ему идентификаторы моделей.
 * Бинарь большой (~230 МБ) — читаем потоком чанками с нахлёстом (id не должен
 * разорваться на границе), поэтому скан гоняем только при смене версии CLI.
 */
async function scanBinary(binPath: string) {
  const found = new Map<string, FoundModel>();
  const registry = new Map<string, RegistryEntry>();
  let oauth: { tokenUrl: string; clientId: string } | null = null;
  const OVERLAP = 8192;
  let tail = '';
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(binPath, { highWaterMark: 4 * 1024 * 1024 });
    rs.on('data', (chunk: string | Buffer) => {
      // latin1: любые байты → символы 1:1, id из ASCII не потеряются.
      const text = tail + chunk.toString('latin1');
      for (const m of text.matchAll(MODEL_RE)) {
        found.set(m[0], {
          family: String(m[1]),
          major: String(m[2]),
          minor: m[3] || '',
          big: !!m[4],
        });
      }
      for (const m of text.matchAll(REGISTRY_RE)) {
        // Запись встречается и в нахлёсте соседних чанков. Оборванную пока не пишем:
        // полная версия из следующего чанка перезапишет её, а настоящий обрыв останется
        // без записи и получит per-model признаки недостоверности.
        const entry = registryObjectAt(text, m.index);
        if (entry) registry.set(String(m[1]), { family: m[2], ...parseRegistryEntry(entry) });
      }
      if (!oauth) {
        const match = text.match(OAUTH_RE);
        if (match) oauth = { tokenUrl: String(match[1]), clientId: String(match[2]) };
      }
      tail = text.slice(-OVERLAP);
    });
    rs.on('end', () => resolve());
    rs.on('error', reject);
  });
  return { models: found, registry, oauth };
}

// Кэш скана: ключ — realpath бинаря, значение — его отпечаток и результат скана.
type BinaryScan = Awaited<ReturnType<typeof scanBinary>> | null;

const binaryCache = new Map<string, { fingerprint: string; promise: Promise<BinaryScan> }>();

async function binaryMetadata(config: { claudeBin?: unknown }): Promise<BinaryScan> {
  const binPath = await resolveBin(String(config.claudeBin));
  if (!binPath) return null;
  let fingerprint: string;
  try {
    const stat = await fs.stat(binPath, { bigint: true });
    fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
  const cached = binaryCache.get(binPath);
  if (!cached || cached.fingerprint !== fingerprint) {
    binaryCache.set(binPath, {
      fingerprint,
      promise: scanBinary(binPath).catch(() => null),
    });
  }
  return binaryCache.get(binPath)?.promise ?? null;
}

/** Публичные OAuth-метаданные установленного Claude CLI или null. */
export async function claudeOauthMetadata(config: { claudeBin?: unknown }) {
  return (await binaryMetadata(config))?.oauth || null;
}

/**
 * Полный каталог моделей установленного CLI: конкретные версии (из бинаря)
 * + алиасы, которые CLI резолвит сам («последняя Opus»).
 * Возвращает null, если бинарь не найден/не читается — реестр останется на прежних данных.
 */
export async function claudeCatalog(config: { claudeBin?: unknown }) {
  const meta = await binaryMetadata(config);
  const found = meta?.models;
  if (!found?.size) return null;
  const registry = meta?.registry || new Map<string, RegistryEntry>();
  // Тот же выключатель, что читает сам CLI (`CLAUDE_CODE_DISABLE_1M_CONTEXT`): с ним
  // миллион недоступен вообще, и показывать его в кольце было бы враньём. Проверка
  // повторяет bool-parser бинаря (`1|true|yes|on`).
  const no1m = oneMillionDisabled();
  // Ступени эффорта, которые требуют персонального разрешения модели: собираем ПО ВСЕМУ
  // реестру (`xhigh_effort`, `max_effort` → xhigh, max). Списком в коде это быть не может —
  // тогда новая ступень снова чинилась бы правкой под каждую модель.
  const effortGates = [...new Set([...registry.values()]
    .flatMap((r) => (Array.isArray(r.capabilities) ? r.capabilities : []))
    .filter((c) => c.endsWith('_effort'))
    .map((c) => c.slice(0, -'_effort'.length)))];

  // Бинарь помнит и древности (Opus 4.0, Sonnet 3.7…). Из каталога их НЕ выбрасываем —
  // помечаем `extra: true` («не в кратком списке»), а показывать ли, решает настройка
  // «показывать все модели».
  const byFamily = new Map<string, Map<string, Array<FoundModel & { id: string }>>>();
  for (const [id, m] of found) {
    const ver = `${m.major}.${m.minor || 0}`;
    if (!byFamily.has(m.family)) byFamily.set(m.family, new Map());
    const versions = byFamily.get(m.family);
    if (!versions?.has(ver)) versions?.set(ver, []);
    versions?.get(ver)?.push({ id, ...m });
  }

  const models: Array<Record<string, unknown>> = [];
  const latestOf = new Map<string, string>(); // family → id самой свежей модели
  const retiredModelRefs: Array<[string, string]> = []; // [baseId, 'claude-opus-5[1m]']
  for (const [family, versions] of byFamily) {
    const ordered = [...versions.entries()].sort((a, b) => cmpVersion(b[0], a[0]));
    ordered.forEach(([, entries], vi) => {
      for (const m of entries) {
        if (vi === 0 && !m.big && !latestOf.has(family)) latestOf.set(family, m.id);
        const baseId = m.id.replace(/\[1m\]$/i, '');
        // У модели со ВСТРОЕННЫМ миллионом суффикс `[1m]` не добавляет ничего: окно
        // и там и там одно. Отдельным пунктом это два одинаковых выбора в селекте,
        // поэтому вариант становится АЛИАСОМ базовой модели — сохранённый в чатах
        // `claude-opus-5[1m]` продолжает резолвиться, но пункт в списке один.
        // У Opus 4.6 суффикс остаётся пунктом: там он реально поднимает 200k → 1M.
        // С выключенным 1M любой suffix-вариант эквивалентен базе и отдельным пунктом
        // быть не должен: «Opus 4.6 (1M) · 200k» одновременно врёт и дублирует модель.
        // Если 1M включён, сворачиваем только suffix у модели со встроенным миллионом.
        if (m.big && (no1m || registry.get(baseId)?.native1m
          || Number(registry.get(baseId)?.window) >= 1_000_000)) {
          if (found.has(baseId)) retiredModelRefs.push([baseId, m.id]);
          continue;
        }
        // Вариант `[1m]` — форма той же модели, а не отдельная запись реестра:
        // окно и подпись берём у базовой.
        const reg = registry.get(baseId);
        // Disable-1M — авторитетный policy cap: эффективные 200k известны даже при
        // сломанной записи registry и не должны заменяться прошлым миллионом при merge.
        const contextVerified = no1m || (Number.isFinite(reg?.window) && Number(reg?.window) > 0);
        const effortVerified = Array.isArray(reg?.capabilities);
        const nameVerified = !!reg?.displayName;
        const maxOutputVerified = Number.isFinite(reg?.maxOutput) && Number(reg?.maxOutput) > 0;
        const metadataUnverified = !nameVerified || !contextVerified
          || !maxOutputVerified || !effortVerified;
        models.push({
          id: m.id,
          family: m.family,
          // Подпись из реестра точнее выведенной из id: её пишет сам вендор.
          name: reg?.displayName ? `${reg.displayName}${m.big ? ' (1M)' : ''}`
            : modelName(m.family, m.major, m.minor, m.big),
          // Порядок ровно как в бинаре: выключатель сильнее всего, затем миллион
          // (суффиксом `[1m]` ИЛИ встроенный), затем окно из реестра. 200000 остаётся
          // последним рубежом — только для id, которых в реестре нет вовсе.
          context: no1m ? 200000
            : (m.big || reg?.native1m) ? 1000000
            : (reg?.window || 200000),
          maxOutput: reg?.maxOutput || null,
          // Недостоверность — свойство КОНКРЕТНОЙ записи. Одна здоровая модель не должна
          // маскировать сломанный `context` соседней; при деградации merge сохранит
          // последнее проверенное значение, но этот признак намеренно не снимет.
          ...(!contextVerified && { contextUnverified: true }),
          ...(!nameVerified && { nameUnverified: true }),
          ...(!maxOutputVerified && { maxOutputUnverified: true }),
          ...(metadataUnverified && { metadataUnverified: true }),
          tier: modelTier(m.family, m.major, m.minor, m.big),
          efforts: null,
          // Возможности объявляет сам реестр бинаря. Ладдер эффорта по-прежнему даёт
          // `claude --help` (имена и порядок), а вот КОМУ из моделей какая ступень
          // доступна, знает только эта таблица: у Opus 4.6 нет `xhigh_effort`,
          // у Opus 5 есть. Гейт применяет modelEfforts() исполнителя.
          ...(effortVerified
            ? { capabilities: reg?.capabilities, effortGates }
            : { effortUnverified: true }),
          inputModalities: ['text', 'image'],
          extra: vi >= KEEP_VERSIONS,
          // Форма той же версии: общий краткий список держит её рядом с базовой моделью.
          ...(m.big && { variantOf: baseId }),
        });
      }
    });
  }

  // Алиасы CLI (`opus`/`sonnet`/`haiku`) отдельными пунктами НЕ показываем: это та же самая
  // модель под другим именем, два пункта на одно и то же только путают. Вместо этого
  // привязываем алиас к модели, в которую CLI его резолвит (последняя версия семейства) —
  // сохранённый где-то выбор «opus» отображается как актуальная Opus и туда же уходит запрос.
  // После обновления бинаря тот же выбор сам переедет на новую версию: всё берётся из CLI.
  for (const [alias, family] of [
    ['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku'],
  ] as const) {
    const rec = models.find((m) => m.id === latestOf.get(family));
    if (rec) ((rec.aliases ||= []) as string[]).push(alias);
  }
  // Свёрнутые exact-id НЕ кладём в обычные `aliases`: там живут динамические CLI-алиасы
  // (`opus`), которые versioned modelRef разрешать не имеет права. Отдельное поле говорит:
  // этот прежний exact id теперь полностью эквивалентен каноническому.
  for (const [baseId, aliasId] of retiredModelRefs) {
    const rec = models.find((m) => m.id === baseId);
    if (rec) ((rec.modelRefAliases ||= []) as string[]).push(aliasId);
  }
  return models.sort((a, b) => Number(b.tier) - Number(a.tier));
}

/**
 * Persisted fingerprint факторов каталога, не входящих в версию CLI. Реестр вызывает
 * hook обобщённо для любого executor-а; смена env после перезапуска не должна оставлять
 * старые миллионные окна в `models.json` при той же версии бинаря.
 */
export function claudeCatalogCacheKey() {
  return `disable-1m:${oneMillionDisabled() ? '1' : '0'}`;
}

/**
 * Сравнение версий вида «4.6» / «5.0».
 */
function cmpVersion(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return am - bm || an - bn;
}
