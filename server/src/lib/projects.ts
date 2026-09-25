// Паспорта проектов: откуда кокпит знает пути репозиториев проекта на диске.
// Источник №1 — профиль фабрики (PROFILE_TRIAGE_REPOS, читается через loadTriageProfile):
// пока идёт миграция, для проектов фабрики пути живут ТАМ, и второй источник тут же
// разъехался бы с первым (инкремент B переведёт читателей на паспорт).
// Источник №2 — реестр prefs.projects.<id>: паспорт проекта, заведённого в кокпите.
//
// Записи реестра бывают двух поколений: старая знает только `repos`, новая — весь
// паспорт. Читатели получают одну форму через readProjectRecord: разбирать умолчания
// каждому потребителю по-своему нельзя, иначе они разойдутся между собой.
import { PROFILE_RE, listFactoryProfiles } from './profiles.ts';
import { loadTriageProfile } from './analysis/profile.ts';
import type { TriageProfilePaths } from './analysis/profile.ts';

// Архивность читают и соседние разделы, поэтому она живёт отдельным модулем;
// здесь — только реэкспорт, чтобы у читателей паспорта была одна точка входа.
export { archivedProjectIds, isProjectArchived } from './projects/archive.ts';

// Паспорту проекта нужен каталог профилей и пути чтения bash-профиля; каталог
// маршрутов читает только сводка раздела. Полная форма config — в config.ts.
type ProjectPathsConfig = TriageProfilePaths & {
  profilesDir: string;
};

// Prefs как источник паспортов. Содержимое недоверенное: форму каждой записи
// проверяет нормализация, поэтому порт объявляет только сам факт чтения.
export interface ProjectsPrefsReader {
  read?: () => unknown;
}

/** Метка и путь репозитория: то, что лежит в паспорте и уходит в «Код». */
export interface ProjectRepoRef {
  key: string;
  dir: string;
}

/** Репозиторий проекта: метка, путь и то, кто этот путь назвал. */
export interface ProjectRepo extends ProjectRepoRef {
  from: string;
}

export type ProjectImportStatus =
  | 'none'
  | 'pending'
  | 'imported'
  | 'conflict'
  | 'failed'
  | 'manual';

// Состояние переноса путей из профиля фабрики: у старой записи его нет вовсе.
export interface ProjectImport {
  status: ProjectImportStatus;
  fingerprint: string | null;
  at: string | null;
  error: string | null;
  candidates: { prefs: ProjectRepoRef[]; profile: ProjectRepoRef[] } | null;
}

/** Паспорт проекта в полной форме: legacy-запись дополняется умолчаниями. */
export interface ProjectRecord {
  title: string;
  description: string;
  tags: string[];
  repos: ProjectRepoRef[];
  defaultRepoKey: string | null;
  archivedAt: string | null;
  import: ProjectImport;
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Служебные данные реестра: версия схемы, время миграции и надгробия удалённых. */
export interface ProjectsMeta {
  schemaVersion: number;
  migratedAt: string | null;
  tombstones: Record<string, { deletedAt: string; revision: number }>;
}

const IMPORT_STATUSES: readonly ProjectImportStatus[] = [
  'none',
  'pending',
  'imported',
  'conflict',
  'failed',
  'manual',
];

const EMPTY_IMPORT: ProjectImport = {
  status: 'none',
  fingerprint: null,
  at: null,
  error: null,
  candidates: null,
};

// Чтение профиля — это source bash-файла (см. analysis/profile.ts), не дёшево.
// Короткого кэша хватает: профили правятся руками и редко.
const TTL = 15_000;
// имя профиля → его последнее прочтение, чтобы не пересорсить bash на каждый запрос.
const cache = new Map<string, { at: number; profile: Awaited<ReturnType<typeof loadTriageProfile>> }>();

// Ключ кэша — каталог профилей вместе с именем: в одном процессе бывает несколько
// фабрик (тесты, вложенные установки), и один и тот же id в них означает разные профили.
function cacheKey(config: ProjectPathsConfig, name: string): string {
  return `${config.profilesDir}\u0000${config.factoryHome ?? ''}\u0000${name}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function wholeOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// Реестр prefs недоверенный и может быть нечитаемым: паспорт тогда пуст, а не падает
// вместе со всем разделом. Форму каждой записи всё равно проверяет читатель.
function readPrefs(prefs: ProjectsPrefsReader | null | undefined): Record<string, unknown> {
  try {
    return asRecord(prefs?.read?.());
  } catch {
    return {};
  }
}

function storedProjects(prefs: ProjectsPrefsReader | null | undefined): Record<string, unknown> {
  return asRecord(readPrefs(prefs).projects);
}

/** Репозитории из недоверенного значения: пустые и нестроковые строки отбрасываются. */
function repoRefs(value: unknown): ProjectRepoRef[] {
  const refs: ProjectRepoRef[] = [];

  for (const row of Array.isArray(value) ? value : []) {
    const source = asRecord(row);
    const key = typeof source.key === 'string' ? source.key : '';
    const dir = typeof source.dir === 'string' ? source.dir : '';

    if (key && dir) {
      refs.push({ key, dir });
    }
  }

  return refs;
}

function normalizeImport(value: unknown): ProjectImport {
  const source = asRecord(value);
  const status = IMPORT_STATUSES.includes(source.status as ProjectImportStatus)
    ? source.status as ProjectImportStatus
    : 'none';
  const candidates = source.candidates === null || source.candidates === undefined
    ? null
    : asRecord(source.candidates);

  return {
    status,
    fingerprint: optionalText(source.fingerprint),
    at: optionalText(source.at),
    error: optionalText(source.error),
    candidates: candidates
      ? { prefs: repoRefs(candidates.prefs), profile: repoRefs(candidates.profile) }
      : null,
  };
}

function tombstonesOf(value: unknown): ProjectsMeta['tombstones'] {
  const tombstones: ProjectsMeta['tombstones'] = {};

  for (const [id, entry] of Object.entries(asRecord(value))) {
    const source = asRecord(entry);
    const deletedAt = optionalText(source.deletedAt);

    if (deletedAt) {
      tombstones[id] = { deletedAt, revision: wholeOr(source.revision, 0) };
    }
  }

  return tombstones;
}

/**
 * Паспорт проекта в полной форме. Legacy-запись без названия читается как «название —
 * это id», без ревизии — как нулевая: до появления ревизий записи никто не версионировал,
 * и считать их «только что изменёнными» нельзя.
 * @returns паспорт либо null, если записи нет или она не объект
 */
export function readProjectRecord(
  prefs: ProjectsPrefsReader | null | undefined,
  id: string,
): ProjectRecord | null {
  const raw = storedProjects(prefs)[id];

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const source = raw as Record<string, unknown>;

  return {
    title: textOr(source.title, '') || id,
    description: textOr(source.description, ''),
    tags: (Array.isArray(source.tags) ? source.tags : [])
      .filter((tag): tag is string => typeof tag === 'string'),
    repos: repoRefs(source.repos),
    defaultRepoKey: optionalText(source.defaultRepoKey),
    archivedAt: optionalText(source.archivedAt),
    import: source.import === undefined ? { ...EMPTY_IMPORT } : normalizeImport(source.import),
    revision: wholeOr(source.revision, 0),
    createdAt: optionalText(source.createdAt),
    updatedAt: optionalText(source.updatedAt),
  };
}

/** Все паспорта реестра по возрастанию id; ключи вне PROFILE_RE пропускаются. */
export function listProjectRecords(
  prefs: ProjectsPrefsReader | null | undefined,
): Array<ProjectRecord & { id: string }> {
  return Object.keys(storedProjects(prefs))
    .filter((id) => PROFILE_RE.test(id))
    .sort()
    .flatMap((id) => {
      const record = readProjectRecord(prefs, id);

      return record ? [{ ...record, id }] : [];
    });
}

/** Служебные данные реестра: отсутствие ключа читается как «миграции ещё не было». */
export function readProjectsMeta(prefs: ProjectsPrefsReader | null | undefined): ProjectsMeta {
  const source = asRecord(readPrefs(prefs).projectsMeta);

  return {
    schemaVersion: wholeOr(source.schemaVersion, 0),
    migratedAt: optionalText(source.migratedAt),
    tombstones: tombstonesOf(source.tombstones),
  };
}

// Форма записи о репозитории: метка и путь строками. Схлопывания одинаковых корней и
// переименования ключа здесь больше нет: ключ паспорта — это ключ плагина «Код», и
// алиасы одного каталога (BE/FE) обязаны доехать до него под своими именами.
function normalizeProjectRepos(repos: unknown, from: string): ProjectRepo[] {
  return repoRefs(repos).map((repo) => ({ ...repo, from }));
}

/**
 * Профиль фабрики с коротким кэшем: source bash-файла не дёшев, а профили правят руками
 * и редко. Кэш общий на процесс — раздел «Проекты» и плагин «Код» читают один профиль.
 */
export async function cachedTriageProfile(config: ProjectPathsConfig, name: string) {
  const key = cacheKey(config, name);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.profile;
  const profile = await loadTriageProfile(config, name);
  cache.set(key, { at: Date.now(), profile });
  return profile;
}

async function factoryRepos(config: ProjectPathsConfig, name: string) {
  return (await cachedTriageProfile(config, name)).repos;
}

/**
 * Репозитории проекта: [{key, dir, from: 'factory'|'cockpit'}]. Может быть пусто —
 * профиль без PROFILE_TRIAGE_REPOS или кокпитный проект, где пути ещё не заданы
 * (тогда кокпитные пути работают и для фабричного проекта — как фолбэк, не перекрытие).
 * Пока идёт миграция, непустой профиль фабрики остаётся источником путей.
 */
export async function projectRepos({ config, prefs, id, isFactory = null }: {
  config: ProjectPathsConfig;
  prefs: ProjectsPrefsReader;
  id: string;
  isFactory?: boolean | null;
}): Promise<ProjectRepo[]> {
  const factory = isFactory ?? (await listFactoryProfiles(config.profilesDir)).includes(id);
  if (factory) {
    const repos = await factoryRepos(config, id);
    if (repos.length) return normalizeProjectRepos(repos, 'factory');
  }
  return normalizeProjectRepos(readProjectRecord(prefs, id)?.repos ?? [], 'cockpit');
}
