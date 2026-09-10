// Ведро лимитов, которого раньше не было, легко пропустить: `gpt-reserve` появился
// молча и был замечен только глазами. Метка «новое» живёт в состоянии СЕРВЕРА, а не
// в браузере: вёдра общие для всех окон, и планшет не должен объявлять новым то, что
// человек уже прочитал на компьютере.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

// Метка гаснет сама через две недели. Подтверждения человеком нет НАМЕРЕННО: всплывашка
// раскрывается наведением, и случайный проезд мышью снимал бы метку, которую никто не
// прочитал, — то есть ровно тот отказ, против которого метка и заведена.
const FRESH_MS = 14 * 24 * 60 * 60 * 1000;

// Вёдер у аккаунта единицы; упереться в потолок можно только если сервис начнёт
// переименовывать id. Вытесняются лишь те, которых в текущем ответе уже нет.
const MAX_GROUPS_PER_PROVIDER = 64;

// «Было всегда»: базовая линия и снятая метка выглядят одинаково и обе не светятся.
const ALWAYS = 0;

// Когда каждое ведро лимитов увидели впервые: `0` означает «было всегда».
export type FirstSeenMap = Record<string, number>;

// Документ на диске: версия схемы и карта по исполнителям.
interface SeenDocument {
  schemaVersion: number;
  providers: Record<string, FirstSeenMap>;
}

function emptyDocument(): SeenDocument {
  return { schemaVersion: SCHEMA_VERSION, providers: {} };
}

/**
 * Битый или чужой по версии файл не имеет права уронить шапку и не имеет права
 * превратиться в ложную тревогу: возвращаем пустой документ, и ближайшее наблюдение
 * заново поставит базовую линию. Потерять метку тут дешевле, чем объявить новыми
 * сразу все вёдра.
 */
function readDocument(filePath: string): SeenDocument {
  let raw: string;

  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return emptyDocument();
  }

  try {
    const value = JSON.parse(raw);

    if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION
      || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
      return emptyDocument();
    }

    const providers: Record<string, FirstSeenMap> = {};

    for (const [providerId, record] of Object.entries(value.providers)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        continue;
      }

      const firstSeen: FirstSeenMap = {};

      for (const [group, at] of Object.entries(record)) {
        if (typeof group === 'string' && group && Number.isSafeInteger(at) && Number(at) >= 0) {
          firstSeen[group] = Number(at);
        }
      }

      providers[providerId] = firstSeen;
    }

    return { schemaVersion: SCHEMA_VERSION, providers };
  } catch {
    return emptyDocument();
  }
}

/**
 * Хранит время ПЕРВОГО появления каждого ведра лимитов. Главный инвариант — базовая
 * линия: первое наблюдение исполнителя записывает все его вёдра как «было всегда»,
 * иначе первый же показ объявит новым сразу весь список. Та же грабля, что с меткой
 * «новая» у задач B24, где пустой набор нельзя путать с «ничего не открывали».
 */
export class ProviderUsageSeenStore {
  readonly filePath: string;

  readonly now: () => number;

  private document: SeenDocument;

  constructor({ filePath, now = () => Date.now() }: {
    filePath: string;
    now?: () => number;
  }) {
    this.filePath = filePath;
    this.now = now;
    this.document = readDocument(filePath);
  }

  /**
   * Возвращает карту `ведро → время первого появления` для этого исполнителя и
   * дописывает в неё вёдра, которых раньше не видели. Вытесняются только вёдра,
   * отсутствующие в текущем ответе: выброси запись присутствующего — и оно тут же
   * вернётся с новым временем, то есть притворится новым.
   */
  observe(providerId: string, groups: readonly unknown[]): FirstSeenMap {
    const unique = [...new Set(
      groups.filter((group): group is string => typeof group === 'string' && Boolean(group)),
    )];

    if (!providerId || !unique.length) {
      return this.document.providers[providerId] || {};
    }

    const known = this.document.providers[providerId];
    const baseline = !known;
    const firstSeen = { ...(known || {}) };
    const at = this.now();
    let changed = baseline;

    for (const group of unique) {
      if (firstSeen[group] === undefined) {
        firstSeen[group] = baseline ? ALWAYS : at;
        changed = true;
      }
    }

    const present = new Set(unique);
    const absent = Object.keys(firstSeen).filter((group) => !present.has(group));

    while (Object.keys(firstSeen).length > MAX_GROUPS_PER_PROVIDER && absent.length) {
      absent.sort((a, b) => Number(firstSeen[a]) - Number(firstSeen[b]));
      delete firstSeen[String(absent.shift())];
      changed = true;
    }

    this.document.providers[providerId] = firstSeen;

    if (changed) {
      this._persist();
    }

    return firstSeen;
  }

  /**
   * Запись атомарная и best-effort: метка «новое» — украшение шапки, и её потеря не
   * повод уронить ответ о лимитах. Ошибку возвращаем вызывающему на журнал.
   */
  _persist(): Error | null {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.document), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);

      return null;
    } catch (error) {
      return error as Error;
    }
  }
}

// Ноль означает базовую линию и никогда не светится, сколько бы времени ни прошло.
export function isFreshGroup(firstSeenAt: unknown, now = Date.now()): boolean {
  return Number.isSafeInteger(firstSeenAt)
    && Number(firstSeenAt) > ALWAYS
    && now - Number(firstSeenAt) < FRESH_MS;
}
