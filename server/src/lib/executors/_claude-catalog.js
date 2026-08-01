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
export function modelName(family, major, minor, big) {
  const ver = minor ? `${major}.${minor}` : String(major);
  return `${FAMILY_NAME[family] || family} ${ver}${big ? ' (1M)' : ''}`;
}

/**
 * Ранг: семейство × 100 + версия. Вариант [1m] — сразу под своей базовой моделью.
 */
function modelTier(family, major, minor, big) {
  return (FAMILY_TIER[family] || 10) * 100 + Number(major) * 10 + Number(minor || 0) - (big ? 1 : 0);
}

/**
 * Абсолютный путь к бинарю CLI (claudeBin может быть просто именем в PATH).
 */
async function resolveBin(bin) {
  if (bin.includes(path.sep)) return fs.realpath(bin).catch(() => bin);
  const which = await new Promise((resolve) => {
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
async function scanBinary(binPath) {
  const found = new Map(); // id → { family, major, minor, big }
  let oauth = null;
  const OVERLAP = 8192;
  let tail = '';
  await new Promise((resolve, reject) => {
    const rs = createReadStream(binPath, { highWaterMark: 4 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      // latin1: любые байты → символы 1:1, id из ASCII не потеряются.
      const text = tail + chunk.toString('latin1');
      for (const m of text.matchAll(MODEL_RE)) {
        found.set(m[0], { family: m[1], major: m[2], minor: m[3] || '', big: !!m[4] });
      }
      if (!oauth) {
        const match = text.match(OAUTH_RE);
        if (match) oauth = { tokenUrl: match[1], clientId: match[2] };
      }
      tail = text.slice(-OVERLAP);
    });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  return { models: found, oauth };
}

const binaryCache = new Map(); // realpath бинаря → Promise<{models, oauth}>

async function binaryMetadata(config) {
  const binPath = await resolveBin(config.claudeBin);
  if (!binPath) return null;
  if (!binaryCache.has(binPath)) {
    binaryCache.set(binPath, scanBinary(binPath).catch(() => null));
  }
  return binaryCache.get(binPath);
}

/** Публичные OAuth-метаданные установленного Claude CLI или null. */
export async function claudeOauthMetadata(config) {
  return (await binaryMetadata(config))?.oauth || null;
}

/**
 * Полный каталог моделей установленного CLI: конкретные версии (из бинаря)
 * + алиасы, которые CLI резолвит сам («последняя Opus»).
 * Возвращает null, если бинарь не найден/не читается — реестр останется на прежних данных.
 */
export async function claudeCatalog(config) {
  const found = (await binaryMetadata(config))?.models;
  if (!found?.size) return null;

  // Бинарь помнит и древности (Opus 4.0, Sonnet 3.7…). Из каталога их НЕ выбрасываем —
  // помечаем `extra: true` («не в кратком списке»), а показывать ли, решает настройка
  // «показывать все модели».
  const byFamily = new Map(); // family → Map('4.6' → [записи])
  for (const [id, m] of found) {
    const ver = `${m.major}.${m.minor || 0}`;
    if (!byFamily.has(m.family)) byFamily.set(m.family, new Map());
    const versions = byFamily.get(m.family);
    if (!versions.has(ver)) versions.set(ver, []);
    versions.get(ver).push({ id, ...m });
  }

  const models = [];
  const latestOf = new Map(); // family → id самой свежей модели (в неё резолвится алиас)
  for (const [family, versions] of byFamily) {
    const ordered = [...versions.entries()].sort((a, b) => cmpVersion(b[0], a[0]));
    ordered.forEach(([, entries], vi) => {
      for (const m of entries) {
        if (vi === 0 && !m.big && !latestOf.has(family)) latestOf.set(family, m.id);
        models.push({
          id: m.id,
          family: m.family,
          name: modelName(m.family, m.major, m.minor, m.big),
          context: m.big ? 1000000 : 200000,
          tier: modelTier(m.family, m.major, m.minor, m.big),
          efforts: null,
          extra: vi >= KEEP_VERSIONS,
        });
      }
    });
  }

  // Алиасы CLI (`opus`/`sonnet`/`haiku`) отдельными пунктами НЕ показываем: это та же самая
  // модель под другим именем, два пункта на одно и то же только путают. Вместо этого
  // привязываем алиас к модели, в которую CLI его резолвит (последняя версия семейства) —
  // сохранённый где-то выбор «opus» отображается как актуальная Opus и туда же уходит запрос.
  // После обновления бинаря тот же выбор сам переедет на новую версию: всё берётся из CLI.
  for (const [alias, family] of [['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku']]) {
    const rec = models.find((m) => m.id === latestOf.get(family));
    if (rec) (rec.aliases ||= []).push(alias);
  }
  return models.sort((a, b) => b.tier - a.tier);
}

/**
 * Сравнение версий вида «4.6» / «5.0».
 */
function cmpVersion(a, b) {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}
