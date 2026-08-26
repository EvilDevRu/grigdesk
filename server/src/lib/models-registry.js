// Реестр моделей исполнителей — данные, а не хардкод в компонентах:
//   • сид собирается из исполнителей (lib/executors/*.seedModels) и один раз пишется
//     в server/.state/models.json — файл РЕДАКТИРУЕМЫЙ: вышла новая модель →
//     дописал строку в json, код не трогаем;
//   • уровни эффорта обнаруживаются динамически (executor.efforts(), например парсинг
//     `claude --help`) — добавит вендор новый уровень (ultra и т.п.) — подхватится само;
//   • сортировка по tier (сильнее = больше = выше в списке), тоже данные из файла.
// У каждой модели: id (что передаём CLI), family (долгоживущая policy), name
// (с версией — для UI), context (окно), efforts (уровни; null = взять обнаруженные
// у исполнителя), tier (ранг силы).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getExecutors } from './executors/index.js';

// Версия правил составления каталога. Меняем, когда меняется САМ принцип отбора моделей
// (например «в кратком списке — только свежая версия семейства») — иначе у работающих
// кокпитов в реестре останется список, собранный по старым правилам.
// 9: окно контекста Claude берётся из реестра моделей ВНУТРИ бинаря CLI, а не выводится
//    из имени («есть [1m] — миллион, иначе 200k»). Прежнее правило занижало окно всему
//    текущему поколению; деградация теперь per-model, а retired exact ids отделены
//    от динамических CLI-алиасов.
// 10: Codex model/list не содержит окно; каталог помечает его runtime-only вместо
//     прежней безусловной заглушки 400k, которую UI выдавал за свойство модели.
const CATALOG_SCHEMA = 10;

let cache = null; // { at, registry }
const CACHE_MS = 60_000;

/**
 * Файл реестра: читаем; при отсутствии — сеем из исполнителей.
 * Новый исполнитель, которого ещё нет в файле, досеивается без перетирания правок.
 */
async function loadFile(modelsPath) {
  const executors = await getExecutors();
  let data = null;
  try { data = JSON.parse(await fs.readFile(modelsPath, 'utf8')); } catch { data = {}; }
  let dirty = false;
  for (const ex of executors.values()) {
    if (!data[ex.id] && typeof ex.seedModels === 'function') {
      data[ex.id] = ex.seedModels();
      dirty = true;
    }
  }
  if (dirty) {
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    await fs.writeFile(modelsPath, JSON.stringify(data, null, 2));
  }
  return data;
}

/**
 * Автообнаружение НОВЫХ моделей (executor.discoverModels → API вендора).
 * Вотермарк по created_at в `_meta`: первая проверка только запоминает текущий максимум,
 * дальше всё, что свежее вотермарка и неизвестно файлу, дописывается ВВЕРХ списка
 * (tier выше максимального) — «Fable 6» появится в селекте сам. Возвращает true, если файл изменился.
 */
async function mergeDiscovered(file, prov, ex, config) {
  if (!ex?.discoverModels) return false;
  let found = null;
  try { found = await ex.discoverModels(config); } catch { found = null; }
  if (!found?.length) return false;

  const meta = (file._meta ||= {});
  const pm = (meta[prov] ||= {});
  const list = (file[prov] ||= []);
  const dated = found.filter((m) => m.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!dated.length) return false;

  if (!pm.watermark) {
    // Первый запуск обнаружения: существующий каталог не тащим (захламил бы селект
    // старыми моделями) — только ставим отметку «что видели».
    pm.watermark = dated[0].createdAt;
    return true;
  }

  const known = new Set(list.map((m) => m.id));
  const fresh = dated.filter((m) => m.createdAt > pm.watermark && !known.has(m.id)).reverse(); // от старых к новым
  if (!fresh.length) return false;
  const maxTier = Math.max(0, ...list.map((m) => m.tier || 0));
  fresh.forEach((m, i) => {
    list.unshift({ id: m.id, name: m.name, context: 200000, tier: maxTier + 10 + i, efforts: null, discovered: true });
  });
  pm.watermark = dated[0].createdAt;
  return true;
}

/**
 * Каталог executor-а — ГЛАВНЫЙ источник правды о моделях: что CLI/аккаунт знает, то и
 * показываем. Локальные каталоги (`catalogLive !== true`) опрашиваем при смене версии
 * CLI; живые — при обновлении минутного кэша реестра, чтобы rollout новой модели
 * появился без обновления Cockpit.
 *
 * Мёрж, а не перезапись: новые модели добавляются, у известных освежаются name/context/tier
 * (кроме записей с `custom: true` — они правлены руками). Пропавшая из каталога модель
 * уходит из списка: состав задаёт каталог, иначе он копит всё, что когда-либо видел любой
 * CLI. Пропажу переживает только ручная запись `custom: true` — она остаётся с пометкой
 * `unknown: true` (полный id CLI обычно принимает и без записи о нём в каталоге).
 */
export async function mergeCatalog(file, prov, ex, config) {
  if (typeof ex?.catalog !== 'function') return false;
  let version = '';
  try { version = (await ex.probe(config))?.version || ''; } catch { version = ''; }
  const meta = (file._meta ||= {});
  const pm = (meta[prov] ||= {});
  const list = (file[prov] ||= []);
  // Версия бинаря не описывает env/policy, влияющие на каталог. Executor при необходимости
  // объявляет дополнительный стабильный fingerprint; ошибка hook-а заставляет повторить
  // каталог, но не фиксируется как успешное состояние.
  const hasCacheKey = typeof ex.catalogCacheKey === 'function';
  let catalogCacheKey = '';
  let cacheKeyVerified = true;
  if (hasCacheKey) {
    try { catalogCacheKey = String(await ex.catalogCacheKey(config)); } catch { cacheKeyVerified = false; }
  }
  // Пересобираем и когда сменилась версия CLI, и когда поменялись правила составления
  // каталога (CATALOG_SCHEMA) — иначе у уже работающих кокпитов остался бы старый список.
  const metadataChanged = pm.catalogVersion !== version
    || pm.catalogSchema !== CATALOG_SCHEMA
    || (hasCacheKey && (!cacheKeyVerified || pm.catalogCacheKey !== catalogCacheKey));
  if (!ex.catalogLive && list.length && !metadataChanged) return false;

  let catalog = null;
  try { catalog = await ex.catalog(config); } catch { catalog = null; }
  if (!catalog?.length) {
    // Каталог не прочитался (нет бинаря) — оставляем что есть, версию не фиксируем.
    return false;
  }
  // `modelRefAliases` — миграционная память exact id. Если новый CLI перестал хранить
  // retired id строкой, алиас всё равно нужен старому schema-2 чату. Но если такой id
  // снова является отдельной моделью свежего каталога, exact-запись сильнее stale alias:
  // при непрочитанном context мы не имеем права угадывать их эквивалентность.
  const catalogCopy = catalog.map((model) => ({ ...model }));
  const catalogById = new Map(catalogCopy.map((model) => [model.id, model]));
  for (const current of list) {
    if (current?.custom || !Array.isArray(current?.modelRefAliases)) continue;
    const fresh = catalogById.get(current.id);
    if (!fresh) continue;
    for (const alias of current.modelRefAliases) {
      const exactFresh = catalogById.get(alias);
      if (!exactFresh) {
        fresh.modelRefAliases = [...new Set([...(fresh.modelRefAliases || []), alias])];
      }
    }
  }
  catalog = catalogCopy;
  // Каталог задаёт СОСТАВ списка: что CLI забыл (или мы решили не показывать — старые версии),
  // из выбора уходит. Иначе список копит всё, что когда-либо видел любой CLI, и превращается
  // в свалку. Исключение — записи с `custom: true`: их добавил человек, их не трогаем.
  const prevById = new Map(list.map((m) => [m.id, m]));
  const next = catalog.map((m) => mergeCatalogModel(m, prevById.get(m.id)));
  const inCatalog = new Set(catalog.map((m) => m.id));
  for (const m of list) {
    if (!inCatalog.has(m.id) && m.custom) next.push({ ...m, unknown: true });
  }
  const listChanged = JSON.stringify(list) !== JSON.stringify(next);
  file[prov] = next;
  pm.catalogVersion = version;
  pm.catalogSchema = CATALOG_SCHEMA;
  if (hasCacheKey && cacheKeyVerified) pm.catalogCacheKey = catalogCacheKey;
  return metadataChanged || listChanged;
}

export function mergeCatalogModel(model, current) {
  // Только явно custom-запись перекрывает живой каталог. Обычная сохранённая копия
  // не должна удерживать старый список efforts после обновления CLI.
  if (current?.custom) return { ...model, ...current, unknown: false };
  const merged = { ...model };
  // Непроверенные поля не затирают последнюю проверенную metadata. Признаки деградации
  // при этом ОСТАЮТСЯ: старое окно — полезный ориентир, но выдавать его за свежий факт
  // нельзя. Effort ниже дополнительно fail-closed, пока реестр снова не прочитается.
  if (model.contextUnverified && !model.contextRuntimeOnly && current?.context > 0) {
    merged.context = current.context;
  }
  if (model.nameUnverified && current?.name) {
    merged.name = current.name;
  }
  if (model.maxOutputUnverified && current?.maxOutput > 0) {
    merged.maxOutput = current.maxOutput;
  }
  if (model.effortUnverified) {
    if (Array.isArray(current?.capabilities)) merged.capabilities = [...current.capabilities];
    if (Array.isArray(current?.effortGates)) merged.effortGates = [...current.effortGates];
  }
  return merged;
}

export function resolveModelEfforts(modelEfforts, discoveredEfforts, custom = false) {
  if (custom && Array.isArray(modelEfforts)) return modelEfforts;
  if (Array.isArray(discoveredEfforts)) return discoveredEfforts;
  if (Array.isArray(modelEfforts)) return modelEfforts;
  return [];
}

/**
 * Итоговый реестр: { providerId: [модели с efforts, сортированные по tier desc] }.
 */
export async function getModelsRegistry(config, { refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.registry;
  const executors = await getExecutors();
  const file = await loadFile(config.modelsPath);

  let dirty = false;
  // Каталог установленного CLI (обновляется при смене его версии; refresh — принудительно).
  for (const ex of executors.values()) {
    if (refresh) delete file._meta?.[ex.id]?.catalogVersion;
    if (await mergeCatalog(file, ex.id, ex, config)) dirty = true;
  }
  // Автообнаружение новых моделей у исполнителей, которые это умеют (API вендора).
  for (const ex of executors.values()) {
    if (await mergeDiscovered(file, ex.id, ex, config)) dirty = true;
  }
  if (dirty) await fs.writeFile(config.modelsPath, JSON.stringify(file, null, 2));

  const registry = {};
  for (const [prov, models] of Object.entries(file)) {
    if (prov === '_meta') continue;
    const ex = executors.get(prov);
    let discovered = null;
    if (ex?.efforts) {
      try { discovered = await ex.efforts(config); } catch { discovered = null; }
    }
    registry[prov] = (models || [])
      .map((m) => {
        let family = String(m.family || '').trim();
        if (!family && typeof ex?.modelFamily === 'function') {
          try { family = String(ex.modelFamily(m) || '').trim(); } catch { family = ''; }
        }
        // Ладдер и гейт — РАЗНЫЕ оси. Ладдер (имена и порядок ступеней) даёт живой CLI и
        // он же перебивает устаревший сохранённый список. Кому из моделей какая ступень
        // доступна — знает только исполнитель: `--effort xhigh` на модели без поддержки
        // не игнорируется, а роняет запуск. Правленную руками запись не трогаем.
        let efforts = resolveModelEfforts(m.efforts, discovered, m.custom);
        if (!m.custom && typeof ex?.modelEfforts === 'function') {
          try {
            const allowed = ex.modelEfforts(m, efforts);
            if (Array.isArray(allowed)) efforts = allowed;
          } catch { /* гейт не обязан работать — остаётся общий ладдер */ }
        }
        return {
          ...m,
          ...(family && { family }),
          efforts,
        };
      })
      .sort((a, b) => (b.tier || 0) - (a.tier || 0));
  }
  cache = { at: Date.now(), registry };
  return registry;
}

/**
 * Запись модели + её исполнитель: { provider, model }. null — модели нет в реестре.
 * Нужна там, где важны свойства модели (уровни эффорта, окно контекста), а не только
 * кому её отдать: неподдерживаемый уровень CLI не проглатывает, а падает с ошибкой валидации.
 * Точный id/алиас имеет приоритет; семейство (`sol`) выбирает актуальную не-extra модель.
 */
export function modelInfoFromRegistry(modelId, registry) {
  if (!modelId) return null;
  // Реальный id сильнее любого alias во всём реестре, даже если custom-запись создала
  // коллизию в более раннем provider-е.
  for (const [provider, models] of Object.entries(registry)) {
    const model = models.find((m) => m.id === modelId);
    if (model) return { provider, model };
  }
  for (const [provider, models] of Object.entries(registry)) {
    // Алиас CLI (`opus`) отдельной записи не имеет — он привязан к модели, в которую
    // резолвится: запрос со старым выбором всё равно находит свойства нужной модели.
    const model = models.find((m) => (m.modelRefAliases || []).includes(modelId)
      || (m.aliases || []).includes(modelId));
    if (model) return { provider, model };
  }
  for (const [provider, models] of Object.entries(registry)) {
    const candidates = models.filter((m) => m.family === modelId);
    const model = candidates.sort((a, b) =>
      Number(!!a.extra) - Number(!!b.extra) || Number(b.tier || 0) - Number(a.tier || 0))[0];
    if (model) return { provider, model };
  }
  return null;
}

export async function modelInfo(modelId, config) {
  if (!modelId) return null;
  return modelInfoFromRegistry(modelId, await getModelsRegistry(config));
}
