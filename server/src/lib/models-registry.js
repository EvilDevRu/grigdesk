// Реестр моделей исполнителей — данные, а не хардкод в компонентах:
//   • сид собирается из исполнителей (lib/executors/*.seedModels) и один раз пишется
//     в server/.state/models.json — файл РЕДАКТИРУЕМЫЙ: вышла новая модель →
//     дописал строку в json, код не трогаем;
//   • уровни эффорта обнаруживаются динамически (executor.efforts(), например парсинг
//     `claude --help`) — добавит вендор новый уровень (ultra и т.п.) — подхватится само;
//   • сортировка по tier (сильнее = больше = выше в списке), тоже данные из файла.
// У каждой модели: id (что передаём CLI), name (с версией — для UI), context (окно),
// efforts (уровни; null = взять обнаруженные у исполнителя), tier (ранг силы).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getExecutors } from './executors/index.js';

// Дефолт, если и файла нет, и динамическое обнаружение не сработало.
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'max'];

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
 * Итоговый реестр: { providerId: [модели с efforts, сортированные по tier desc] }.
 */
export async function getModelsRegistry(config) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.registry;
  const executors = await getExecutors();
  const file = await loadFile(config.modelsPath);

  // Автообнаружение новых моделей у исполнителей, которые это умеют.
  let dirty = false;
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
      .map((m) => ({ ...m, efforts: m.efforts || discovered || FALLBACK_EFFORTS }))
      .sort((a, b) => (b.tier || 0) - (a.tier || 0));
  }
  cache = { at: Date.now(), registry };
  return registry;
}

/**
 * Какому исполнителю принадлежит модель (по id из реестра). null — неизвестна.
 */
export async function providerOfModel(modelId, config) {
  if (!modelId) return null;
  const registry = await getModelsRegistry(config);
  for (const [prov, models] of Object.entries(registry)) {
    if (models.some((m) => m.id === modelId)) return prov;
  }
  return null;
}
