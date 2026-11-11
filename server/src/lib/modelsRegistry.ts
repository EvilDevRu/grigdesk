// Реестр моделей исполнителей — данные, а не хардкод в компонентах:
//   • сид собирается из исполнителей (lib/executors/*.seedModels) и один раз пишется
//     в state/models.json папки данных — файл РЕДАКТИРУЕМЫЙ: вышла новая модель →
//     дописал строку в json, код не трогаем;
//   • уровни эффорта обнаруживаются динамически (executor.efforts(), например парсинг
//     `claude --help`) — добавит вендор новый уровень (ultra и т.п.) — подхватится само;
//   • сортировка по tier (сильнее = больше = выше в списке), тоже данные из файла;
//   • краткий список общий для всех: прежние версии семейства получают `extra`.
// У каждой модели: id (что передаём CLI), family (долгоживущая policy), name
// (с версией — для UI), context (окно), efforts (уровни; null = взять обнаруженные
// у исполнителя), tier (ранг силы).
import type { ChatSpeed } from '../../../shared/chat/chatSpeed.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { markSupersededModels } from '../../../shared/chat/modelFamily.ts';
import { getExecutors } from './executors/index.ts';
import type { ExecutorAdapter } from './executors/index.ts';

// Версия правил составления каталога. Меняем, когда меняется САМ принцип отбора моделей
// (например «в кратком списке — только свежая версия семейства») — иначе у работающих
// экземпляров GrigDesk в реестре останется список, собранный по старым правилам.
// 9: окно контекста Claude берётся из реестра моделей ВНУТРИ бинаря CLI, а не выводится
//    из имени («есть [1m] — миллион, иначе 200k»). Прежнее правило занижало окно всему
//    текущему поколению; деградация теперь per-model, а retired exact ids отделены
//    от динамических CLI-алиасов.
// 10: Codex model/list не содержит окно; каталог помечает его runtime-only вместо
//     прежней безусловной заглушки 400k, которую UI выдавал за свойство модели.
// 11: краткий список считает реестр по семействам любого исполнителя, поэтому DeepSeek
//     и GLM больше не пишут всем моделям общее `family: 'default'`.
// 12: скорости модели приходят из native metadata, старый допуск не переносится.
const CATALOG_SCHEMA = 12;

// Запись каталога моделей. Форма открытая: файл редактируется руками, и поля,
// которых ядро не знает, обязаны переживать мёрж.
export interface CatalogModel {
  chatSpeedModes?: ChatSpeed[];
  id: string;
  name?: string;
  family?: string;
  context?: number;
  maxOutput?: number;
  tier?: number;
  efforts?: string[] | null;
  effortHints?: Record<string, string>;
  aliases?: string[];
  modelRefAliases?: string[];
  capabilities?: unknown[];
  effortGates?: unknown[];
  custom?: boolean;
  unknown?: boolean;
  extra?: boolean;
  discovered?: boolean;
  createdAt?: string;
  contextUnverified?: boolean;
  contextRuntimeOnly?: boolean;
  nameUnverified?: boolean;
  maxOutputUnverified?: boolean;
  effortUnverified?: boolean;
  [field: string]: unknown;
}

// Файл models.json: провайдер → его модели плюс служебный `_meta`.
type ModelsFile = Record<string, CatalogModel[] | Record<string, Record<string, unknown>>>;

// Итоговый реестр: провайдер → модели с разрешёнными efforts.
export type ModelsRegistry = Record<string, CatalogModel[]>;

// Кэш одного файла реестра. registry/at — последний успешный результат и время его
// проверки; building — идущая обычная сборка, к которой присоединяются вызовы;
// queue — хвост очереди сборок этого файла, он никогда не отклоняется.
interface RegistryCacheEntry {
  generation: number;
  refreshRequired: boolean;
  registry: ModelsRegistry | null;
  at: number;
  building: Promise<ModelsRegistry> | null;
  queue: Promise<unknown>;
}

const registryCache = new Map<string, RegistryCacheEntry>();
const CACHE_MS = 60_000;

/**
 * Смена доступа отзывает готовый каталог и публикацию уже идущей сборки.
 * Очередь записи сохраняется: новая сборка не пересекается со старым models.json.
 */
export function invalidateModelsRegistry(modelsPath: string): void {
  const entry = registryCacheEntry(modelsPath);

  entry.generation += 1;
  entry.registry = null;
  entry.building = null;
  entry.refreshRequired = true;
}

/**
 * Файл реестра: читаем; при отсутствии — сеем из исполнителей.
 * Новый исполнитель, которого ещё нет в файле, досеивается без перетирания правок.
 */
async function loadFile(modelsPath: string): Promise<ModelsFile> {
  const executors = await getExecutors();
  let data: ModelsFile;
  try { data = JSON.parse(await fs.readFile(modelsPath, 'utf8')); } catch { data = {}; }
  let dirty = false;
  for (const ex of executors.values()) {
    if (!data[ex.id] && typeof ex.seedModels === 'function') {
      data[ex.id] = ex.seedModels() as CatalogModel[];
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
async function mergeDiscovered(
  file: ModelsFile,
  prov: string,
  ex: ExecutorAdapter,
  config: unknown,
): Promise<boolean> {
  if (!ex?.discoverModels) return false;
  let found: CatalogModel[] | null = null;
  try { found = await ex.discoverModels(config) as CatalogModel[]; } catch { found = null; }
  if (!found?.length) return false;

  const meta = (file._meta ||= {}) as Record<string, Record<string, unknown>>;
  const pm = (meta[prov] ||= {});
  const list = (file[prov] ||= []) as CatalogModel[];
  const dated = found
    .filter((m) => m.createdAt)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!dated.length) return false;

  if (!pm.watermark) {
    // Первый запуск обнаружения: существующий каталог не тащим (захламил бы селект
    // старыми моделями) — только ставим отметку «что видели».
    pm.watermark = dated[0]?.createdAt;
    return true;
  }

  const known = new Set(list.map((m) => m.id));
  const fresh = dated
    .filter((m) => String(m.createdAt) > String(pm.watermark) && !known.has(m.id))
    .reverse(); // от старых к новым
  if (!fresh.length) return false;
  const maxTier = Math.max(0, ...list.map((m) => m.tier || 0));
  fresh.forEach((m, i) => {
    list.unshift({ id: m.id, name: m.name, context: 200000, tier: maxTier + 10 + i, efforts: null, discovered: true });
  });
  pm.watermark = dated[0]?.createdAt;
  return true;
}

/**
 * Каталог executor-а — ГЛАВНЫЙ источник правды о моделях: что CLI/аккаунт знает, то и
 * показываем. Локальные каталоги (`catalogLive !== true`) опрашиваем при смене версии
 * CLI; живые — при обновлении минутного кэша реестра, чтобы rollout новой модели
 * появился без обновления GrigDesk.
 *
 * Мёрж, а не перезапись: новые модели добавляются, у известных освежаются name/context/tier
 * (кроме записей с `custom: true` — они правлены руками). Пропавшая из каталога модель
 * уходит из списка: состав задаёт каталог, иначе он копит всё, что когда-либо видел любой
 * CLI. Пропажу переживает только ручная запись `custom: true` — она остаётся с пометкой
 * `unknown: true` (полный id CLI обычно принимает и без записи о нём в каталоге).
 */
export async function mergeCatalog(
  file: ModelsFile,
  prov: string,
  ex: ExecutorAdapter,
  config: unknown,
): Promise<boolean> {
  if (typeof ex?.catalog !== 'function') return false;
  let version = '';
  try {
    version = String((await ex.probe(config) as { version?: unknown })?.version || '');
  } catch { version = ''; }
  const meta = (file._meta ||= {}) as Record<string, Record<string, unknown>>;
  const pm = (meta[prov] ||= {});
  let list = (file[prov] ||= []) as CatalogModel[];
  // Версия бинаря не описывает env/policy, влияющие на каталог. Executor при необходимости
  // объявляет дополнительный стабильный fingerprint; ошибка hook-а заставляет повторить
  // каталог, но не фиксируется как успешное состояние.
  const hasCacheKey = typeof ex.catalogCacheKey === 'function';
  let catalogCacheKey = '';
  let cacheKeyVerified = true;
  if (hasCacheKey) {
    try {
      catalogCacheKey = String(await ex.catalogCacheKey?.(config));
    } catch { cacheKeyVerified = false; }
  }

  const accessScope = ex.catalogAccessScope ? await ex.catalogAccessScope(config) : undefined;
  const accessChanged = accessScope !== undefined && pm.catalogAccessScope !== accessScope;
  const aliasSources = list;

  if (accessChanged) {
    list = list.filter((model) => model.custom);
    file[prov] = list;
    delete pm.watermark;
    pm.catalogAccessScope = accessScope;
  }
  // Пересобираем и когда сменилась версия CLI, и когда поменялись правила составления
  // каталога (CATALOG_SCHEMA) — иначе у уже работающих экземпляров GrigDesk остался бы старый список.
  const metadataChanged = pm.catalogVersion !== version
    || pm.catalogSchema !== CATALOG_SCHEMA
    || (hasCacheKey && (!cacheKeyVerified || pm.catalogCacheKey !== catalogCacheKey));
  if (!ex.catalogLive && list.length && !metadataChanged) return false;

  let catalog: CatalogModel[] | null = null;
  try { catalog = await ex.catalog(config) as CatalogModel[]; } catch { catalog = null; }

  if (!catalog?.length) {
    let changed = accessChanged;

    if (ex.chatSpeed) {
      for (const model of list) {
        if (JSON.stringify(model.chatSpeedModes) !== JSON.stringify(['standard'])) {
          model.chatSpeedModes = ['standard'];
          changed = true;
        }
      }
    }

    return changed;
  }
  // `modelRefAliases` — миграционная память exact id. Если новый CLI перестал хранить
  // retired id строкой, алиас всё равно нужен старому schema-2 чату. Но если такой id
  // снова является отдельной моделью свежего каталога, exact-запись сильнее stale alias:
  // при непрочитанном context мы не имеем права угадывать их эквивалентность.
  const catalogCopy = catalog.map((model) => ({ ...model }));
  const catalogById = new Map(catalogCopy.map((model) => [model.id, model]));

  for (const current of aliasSources) {
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
    if (!inCatalog.has(m.id) && m.custom) {
      next.push({
        ...m,
        unknown: true,
        ...(ex.chatSpeed ? { chatSpeedModes: ['standard'] } : {}),
      });
    }
  }
  const listChanged = JSON.stringify(list) !== JSON.stringify(next);
  file[prov] = next;
  pm.catalogVersion = version;
  pm.catalogSchema = CATALOG_SCHEMA;
  if (hasCacheKey && cacheKeyVerified) pm.catalogCacheKey = catalogCacheKey;
  return metadataChanged || listChanged;
}

export function mergeCatalogModel(
  model: CatalogModel,
  current: CatalogModel | undefined,
): CatalogModel {
  // Только явно custom-запись перекрывает живой каталог. Обычная сохранённая копия
  // не должна удерживать старый список efforts после обновления CLI.
  if (current?.custom) {
    return {
      ...model,
      ...current,
      chatSpeedModes: model.chatSpeedModes,
      unknown: false,
    };
  }
  const merged = { ...model };
  // Непроверенные поля не затирают последнюю проверенную metadata. Признаки деградации
  // при этом ОСТАЮТСЯ: старое окно — полезный ориентир, но выдавать его за свежий факт
  // нельзя. Effort ниже дополнительно fail-closed, пока реестр снова не прочитается.
  if (model.contextUnverified && !model.contextRuntimeOnly && Number(current?.context) > 0) {
    merged.context = current?.context;
  }
  if (model.nameUnverified && current?.name) {
    merged.name = current.name;
  }
  if (model.maxOutputUnverified && Number(current?.maxOutput) > 0) {
    merged.maxOutput = current?.maxOutput;
  }
  if (model.effortUnverified) {
    if (Array.isArray(current?.capabilities)) merged.capabilities = [...current.capabilities];
    if (Array.isArray(current?.effortGates)) merged.effortGates = [...current.effortGates];
  }
  return merged;
}

export function resolveModelEfforts(
  modelEfforts: unknown,
  discoveredEfforts: unknown,
  custom = false,
): string[] {
  if (custom && Array.isArray(modelEfforts)) return modelEfforts as string[];
  if (Array.isArray(discoveredEfforts)) return discoveredEfforts as string[];
  if (Array.isArray(modelEfforts)) return modelEfforts as string[];
  return [];
}

/**
 * Объяснения принадлежат исполнителю, а доступные ступени — конкретной модели.
 * Новый уровень остаётся в выборе даже без справки; ручная модель может задать свою.
 */
export function resolveEffortHints(
  model: CatalogModel,
  executor: Pick<ExecutorAdapter, 'effortHints'>,
  efforts: string[],
): Record<string, string> {
  const hints = model.custom
    ? { ...executor.effortHints, ...model.effortHints }
    : { ...model.effortHints, ...executor.effortHints };

  return Object.fromEntries(efforts.map((effort) => {
    const hint = typeof hints[effort] === 'string' ? hints[effort].trim() : '';

    return [effort, hint || 'Описание этого уровня пока недоступно.'];
  }));
}

/**
 * Готовит копии моделей зарегистрированного исполнителя для runtime-каталога.
 * Семейства и уровни усилия уточняются адаптером, прежние версии семейства уходят
 * в `extra` по общему правилу краткого списка; сохранённые записи не меняются.
 */
async function resolveRuntimeModels(
  models: CatalogModel[],
  executor: ExecutorAdapter,
  config: unknown,
): Promise<CatalogModel[]> {
  let discovered: unknown = null;

  if (executor.efforts) {
    try {
      discovered = await executor.efforts(config);
    } catch {
      discovered = null;
    }
  }

  const resolved = models
    .map((model) => {
      let family = String(model.family || '').trim();

      if (!family && typeof executor.modelFamily === 'function') {
        try {
          family = String(executor.modelFamily(model) || '').trim();
        } catch {
          family = '';
        }
      }

      // Ладдер задаёт общий порядок ступеней, гейт — доступные конкретной модели.
      // Живой CLI обновляет сохранённый ладдер, но ручной custom-выбор остаётся.
      let efforts = resolveModelEfforts(model.efforts, discovered, model.custom);

      if (!model.custom && typeof executor.modelEfforts === 'function') {
        try {
          const allowed = executor.modelEfforts(
            model, efforts, Array.isArray(discovered) ? discovered : null,
          );

          if (Array.isArray(allowed)) {
            efforts = allowed;
          }
        } catch {
          // При ошибке гейта остаётся общий ладдер исполнителя.
        }
      }

      return {
        ...model,
        ...(family && { family }),
        efforts,
        effortHints: resolveEffortHints(model, executor, efforts),
      };
    });

  return markSupersededModels(resolved).sort((a, b) => (b.tier || 0) - (a.tier || 0));
}

/**
 * Итоговый реестр: { providerId: [модели с efforts, сортированные по tier desc] }.
 * Снятые исполнители остаются в файле, но не участвуют в runtime-каталоге.
 *
 * Устаревший реестр отдаётся сразу, а пересборка идёт в фоне, одна на файл: её
 * проверки запускают CLI исполнителей и занимают секунды, а сохранение чата и приём
 * сообщения не должны их ждать. Без готового реестра вызов ждёт общую сборку;
 * refresh всегда ждёт сборку, начатую после запроса.
 */
export async function getModelsRegistry(
  config: { modelsPath: string },
  { refresh = false } = {},
): Promise<ModelsRegistry> {
  const entry = registryCacheEntry(config.modelsPath);

  if (refresh) {
    return enqueueRegistryBuild(entry, config, true);
  }

  if (!entry.registry) {
    return sharedRegistryBuild(entry, config);
  }

  if (Date.now() - entry.at >= CACHE_MS) {
    refreshInBackground(entry, config);
  }

  return entry.registry;
}

/**
 * Запись кэша для файла реестра. Ключ — абсолютный путь файла, поэтому разные
 * конфиги и тесты с разными файлами не получают чужой каталог.
 */
function registryCacheEntry(modelsPath: string): RegistryCacheEntry {
  const key = path.resolve(modelsPath);
  let entry = registryCache.get(key);

  if (!entry) {
    entry = {
      generation: 0,
      refreshRequired: false,
      registry: null,
      at: 0,
      building: null,
      queue: Promise.resolve(),
    };
    registryCache.set(key, entry);
  }

  return entry;
}

/**
 * Ставит сборку в очередь файла: сборки одного файла идут строго по одной, поэтому
 * поздняя фоновая не затирает итог refresh, а записи models.json не пересекаются.
 * Успех обновляет кэш; отказ уходит вызывающему, очередь продолжает работать.
 */
function enqueueRegistryBuild(
  entry: RegistryCacheEntry,
  config: { modelsPath: string },
  refresh: boolean,
): Promise<ModelsRegistry> {
  const generation = entry.generation;
  const isCurrent = () => entry.generation === generation;
  const build = entry.queue.then(() => buildModelsRegistry(
    config, refresh || entry.refreshRequired, isCurrent,
  ));

  entry.queue = build.catch(() => undefined);

  return build.then((registry) => {
    if (!isCurrent()) {
      return sharedRegistryBuild(entry, config);
    }

    entry.registry = registry;
    entry.at = Date.now();
    entry.refreshRequired = false;

    return registry;
  });
}

/**
 * Обычная сборка без refresh — одна на файл: пока она идёт, все вызовы получают
 * то же обещание, а не запускают проверки исполнителей заново.
 */
function sharedRegistryBuild(
  entry: RegistryCacheEntry,
  config: { modelsPath: string },
): Promise<ModelsRegistry> {
  if (entry.building) {
    return entry.building;
  }

  const building = enqueueRegistryBuild(entry, config, false);
  const release = () => {
    if (entry.building === building) {
      entry.building = null;
    }
  };

  entry.building = building;
  building.then(release, release);

  return building;
}

/**
 * Фоновая пересборка устаревшего реестра. Отказ наружу не уходит: вызывающие уже
 * получили прежний реестр. Следующая попытка — не раньше CACHE_MS, чтобы сломанная
 * сборка не запускалась на каждом сохранении чата.
 */
function refreshInBackground(entry: RegistryCacheEntry, config: { modelsPath: string }): void {
  if (entry.building) {
    return;
  }

  const generation = entry.generation;

  sharedRegistryBuild(entry, config).catch(() => {
    if (entry.generation === generation) {
      entry.at = Date.now();
    }
  });
}

/**
 * Одна сборка реестра: досев файла, каталоги CLI, автообнаружение моделей и
 * runtime-копии. refresh заставляет пересобрать каталог CLI независимо от версии.
 */
async function buildModelsRegistry(
  config: { modelsPath: string },
  refresh: boolean,
  isCurrent: () => boolean,
): Promise<ModelsRegistry> {
  const executors = await getExecutors();
  const file = await loadFile(config.modelsPath);

  let dirty = false;
  const meta = file._meta as Record<string, Record<string, unknown>> | undefined;
  // Каталог установленного CLI (обновляется при смене его версии; refresh — принудительно).
  for (const ex of executors.values()) {
    if (refresh) delete meta?.[ex.id]?.catalogVersion;
    if (await mergeCatalog(file, ex.id, ex, config)) dirty = true;
  }
  // Автообнаружение новых моделей у исполнителей, которые это умеют (API вендора).
  for (const ex of executors.values()) {
    if (await mergeDiscovered(file, ex.id, ex, config)) dirty = true;
  }

  if (dirty && isCurrent()) {
    await fs.writeFile(config.modelsPath, JSON.stringify(file, null, 2));
  }

  const registry: ModelsRegistry = {};

  for (const [prov, models] of Object.entries(file)) {
    if (prov === '_meta') {
      continue;
    }

    const executor = executors.get(prov);

    if (!executor) {
      continue;
    }

    registry[prov] = await resolveRuntimeModels((models || []) as CatalogModel[], executor, config);
  }

  return registry;
}

/**
 * Запись модели + её исполнитель: { provider, model }. null — модели нет в реестре.
 * Нужна там, где важны свойства модели (уровни эффорта, окно контекста), а не только
 * кому её отдать: неподдерживаемый уровень CLI не проглатывает, а падает с ошибкой валидации.
 * Точный id/алиас имеет приоритет; семейство (`sol`) выбирает актуальную не-extra модель.
 */
export function modelInfoFromRegistry(
  modelId: unknown,
  registry: ModelsRegistry,
): { provider: string; model: CatalogModel } | null {
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
    const model = models.find((m) => (m.modelRefAliases || []).includes(String(modelId))
      || (m.aliases || []).includes(String(modelId)));
    if (model) return { provider, model };
  }
  for (const [provider, models] of Object.entries(registry)) {
    const candidates = models.filter((m) => m.family === modelId);
    const model = candidates.sort((a, b) => (
      Number(!!a.extra) - Number(!!b.extra) || Number(b.tier || 0) - Number(a.tier || 0)
    ))[0];
    if (model) return { provider, model };
  }
  return null;
}

export async function modelInfo(modelId: unknown, config: { modelsPath: string }) {
  if (!modelId) return null;
  return modelInfoFromRegistry(modelId, await getModelsRegistry(config));
}
