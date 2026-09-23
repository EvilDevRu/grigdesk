// Сервис раздела «Проекты»: паспорта читаются и пишутся только здесь.
//
// Паспорт проекта лежит в общем файле настроек, поэтому все мутации идут через одну
// очередь: параллельные правки разных проектов не затирают друг друга. Внутри очереди
// файл перечитывается заново — снимок, снятый до неё, к моменту записи уже устарел бы.
//
// Проект существует, если есть запись реестра ИЛИ каталог профиля фабрики с graph.json.
// У профиля без записи паспорт синтезируется с нулевой ревизией: первая же правка
// создаёт запись, и до неё человек видит пути профиля, а не пустоту.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PROFILE_RE, listFactoryProfiles, listProjects } from '../../lib/profiles.ts';
import { cachedTriageProfile, readProjectRecord } from '../../lib/projects.ts';
import { checkRepositoryPaths } from '../../lib/projects/repositoryCheck.ts';
import { RoutesStore } from '../routes/store.ts';
import { validateProjectInput } from '../../../../shared/projectsContracts.ts';
import { ProjectsError } from './errors.ts';
import type { PrefsStore } from '../../lib/prefsStore.ts';
import type { ProjectImport, ProjectRecord, ProjectRepoRef } from '../../lib/projects.ts';
import type { RepositoryCheckResult } from '../../lib/projects/repositoryCheck.ts';
import type {
  ProjectDetail,
  ProjectInput,
  ProjectSummary,
} from '../../../../shared/projectsContracts.ts';

export type ProjectsChangeKind =
  | 'created'
  | 'updated'
  | 'archived'
  | 'restored'
  | 'deleted'
  | 'imported';

/** Событие раздела: по нему потребители перечитывают свои снимки. */
export interface ProjectsChange {
  id: string;
  revision: number;
  kind: ProjectsChangeKind;
}

export interface ProjectsServiceConfig {
  factoryHome?: string;
  profilesDir: string;
  routesDir: string;
}

export interface ProjectsServiceOptions {
  config: ProjectsServiceConfig;
  prefs: PrefsStore;
  broadcast?: (event: string, data: unknown) => void;
  now?: () => string;
}

/**
 * Провайдер связей: раздел, который хранит ссылку на проект, сам отвечает, сколько
 * их и как назвать. `blocksArchive` помечает правила: они живут отдельно от проекта
 * и после архива остались бы ссылками в никуда.
 */
export interface ProjectDependencyProvider {
  kind: string;
  label: string;
  blocksArchive: boolean;
  count: (id: string) => Promise<{ count: number; items?: string[] }> | { count: number; items?: string[] };
}

export interface ProjectDependencyItem {
  kind: string;
  label: string;
  count: number;
  items: string[];
}

export interface ProjectDependencies {
  items: ProjectDependencyItem[];
  archivable: boolean;
  deletable: boolean;
  reasons: string[];
}

export interface ProjectsService {
  list: () => Promise<ProjectSummary[]>;
  read: (id: string) => Promise<ProjectDetail>;
  create: (input: unknown) => Promise<ProjectDetail>;
  update: (id: string, input: unknown, expectedRevision: unknown) => Promise<ProjectDetail>;
  archive: (id: string, expectedRevision: unknown) => Promise<ProjectDetail>;
  restore: (id: string, expectedRevision: unknown) => Promise<ProjectDetail>;
  dependencies: (id: string) => Promise<ProjectDependencies>;
  registerDependencyProvider: (provider: ProjectDependencyProvider) => void;
  checkRepositories: (dirs: string[]) => Promise<RepositoryCheckResult[]>;
  onChange: (listener: (change: ProjectsChange) => void) => () => void;
}

// Сколько имён связей показывать: сводка объясняет отказ, а не перечисляет всё.
const DEPENDENCY_ITEMS_LIMIT = 20;

const EMPTY_IMPORT: ProjectImport = {
  status: 'none',
  fingerprint: null,
  at: null,
  error: null,
  candidates: null,
};

/** Состояние профиля фабрики: есть ли он, читается ли и какие пути объявляет. */
interface ProfileState {
  present: boolean;
  readable: boolean | null;
  repos: ProjectRepoRef[];
  capabilities: string[];
}

const ABSENT_PROFILE: ProfileState = {
  present: false,
  readable: null,
  repos: [],
  capabilities: [],
};

/** Текст ошибки провайдера для сводки: у отказа бывает и не-Error. */
function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Строки путей в записи: недоверенный файл настроек проверяется по форме. */
function repoRefsOf(value: unknown): ProjectRepoRef[] {
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

function normalizedRepos(repos: ProjectRepoRef[]): ProjectRepoRef[] {
  return repos.map((repo) => ({ key: repo.key, dir: path.normalize(repo.dir) }));
}

function sameRepos(left: ProjectRepoRef[], right: ProjectRepoRef[]): boolean {
  return left.length === right.length
    && left.every((repo, index) => {
      const other = right[index];

      return Boolean(other) && repo.key === other?.key
        && path.normalize(repo.dir) === path.normalize(other?.dir ?? '');
    });
}

export function createProjectsService({
  config,
  prefs,
  broadcast,
  now = () => new Date().toISOString(),
}: ProjectsServiceOptions): ProjectsService {
  const listeners = new Set<(change: ProjectsChange) => void>();
  const dependencyProviders: ProjectDependencyProvider[] = [];
  let mutationTail: Promise<unknown> = Promise.resolve();

  /**
   * Одна очередь на все мутации реестра: две правки разных проектов, попавшие в неё
   * одновременно, читают файл по очереди и записывают результат поверх свежего
   * снимка, а не поверх того, что был до них.
   */
  function mutate<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);

    return result;
  }

  function announce(change: ProjectsChange): void {
    broadcast?.('projects-changed', change);
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // Подписчик раздела не вправе сорвать уже состоявшуюся запись: паспорт сохранён,
        // и отказ чужого обработчика не должен выглядеть как отказ сохранения.
      }
    }
  }

  function requireId(id: string): void {
    if (!PROFILE_RE.test(String(id ?? ''))) {
      throw new ProjectsError(
        400,
        'bad_id',
        'Идентификатор проекта: строчные латинские буквы, цифры, «-» и «_».',
      );
    }
  }

  /**
   * Ревизия приходит от формы как «та, которую человек видел». Отсутствие и не-число —
   * разные отказы: первое означает старый клиент или потерянное поле, второе — мусор
   * в теле, и разбираться с ними человеку по-разному.
   */
  function requireRevision(value: unknown): number {
    if (value === undefined) {
      throw new ProjectsError(
        400,
        'revision_required',
        'Обновите вкладку: форма не прислала ревизию паспорта.',
      );
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new ProjectsError(400, 'bad_revision', 'Ревизия паспорта — целое неотрицательное число.');
    }

    return value;
  }

  function validated(input: unknown, options: { creating: boolean }): ProjectInput {
    const result = validateProjectInput(input, options);

    if (result.ok) {
      return result.value;
    }

    const [first] = result.fieldErrors;
    throw new ProjectsError(400, first?.code ?? 'bad_request', first?.message ?? 'Тело запроса отклонено.', {
      fieldErrors: result.fieldErrors.map(({ path, message }) => ({ path, message })),
    });
  }

  async function factoryIds(): Promise<Set<string>> {
    return new Set(await listFactoryProfiles(config.profilesDir));
  }

  async function profileStateOf(id: string, present: boolean): Promise<ProfileState> {
    if (!present) {
      return ABSENT_PROFILE;
    }

    const profileDir = path.join(config.profilesDir, id);
    let capabilities: string[] = [];

    try {
      const graph = JSON.parse(await fs.readFile(path.join(profileDir, 'graph.json'), 'utf8'));
      capabilities = (Array.isArray(graph?.capabilities) ? graph.capabilities : [])
        .filter((item: unknown): item is string => typeof item === 'string');
    } catch {
      // Схема битая — но профиль есть: присутствие решает сам файл, а не его разбор.
    }

    // Строгий читатель профиля появится в инкременте B; пока «читается» — это «profile.sh
    // на месте», а непустой список путей говорит сам за себя.
    const hasShell = await fs.access(path.join(profileDir, 'profile.sh'))
      .then(() => true)
      .catch(() => false);
    const profile = hasShell ? await cachedTriageProfile(config, id) : null;

    return {
      present: true,
      readable: hasShell,
      repos: profile ? repoRefsOf(profile.repos) : [],
      capabilities,
    };
  }

  /** Пути проекта: непустой профиль фабрики главнее паспорта — до миграции в B. */
  function effectiveRepos(
    record: ProjectRecord | null,
    profile: ProfileState,
  ): { repos: ProjectRepoRef[]; pathsSource: 'passport' | 'profile' } {
    if (profile.present && profile.repos.length) {
      return { repos: profile.repos, pathsSource: 'profile' };
    }

    return { repos: record?.repos ?? [], pathsSource: 'passport' };
  }

  async function routesOf(id: string): Promise<string[]> {
    try {
      const store = new RoutesStore({ baseDir: config.routesDir });
      const current = await store.readCurrent(id);

      return current ? Object.keys(current.catalog.routes).sort() : [];
    } catch {
      // Каталога нет или он битый — «Маршруты» покажут это подробно, а список проекта
      // не должен пропадать из-за чужого раздела.
      return [];
    }
  }

  async function reposWithExists(repos: ProjectRepoRef[]) {
    return Promise.all(repos.map(async (repo) => ({
      ...repo,
      exists: await fs.access(repo.dir).then(() => true).catch(() => false),
    })));
  }

  /**
   * Предупреждения сводки. Пока одно: несколько ключей на один физический каталог.
   * Это не ошибка — профиль фабрики иногда различает «бэкенд» и «фронтенд» одной
   * копии, — но для «Кода» это одна рабочая копия, и человеку стоит об этом знать.
   */
  function warningsOf(repos: ProjectRepoRef[]): string[] {
    const byRoot = new Map<string, string[]>();

    for (const repo of repos) {
      const root = path.resolve(repo.dir);
      byRoot.set(root, [...(byRoot.get(root) ?? []), repo.key]);
    }

    return [...byRoot.entries()]
      .filter(([, keys]) => keys.length > 1)
      .map(([root, keys]) => `Ключи ${keys.join(', ')} указывают на один каталог ${root}.`);
  }

  async function summaryOf(
    id: string,
    record: ProjectRecord | null,
    profile: ProfileState,
  ): Promise<ProjectSummary> {
    const effective = effectiveRepos(record, profile);
    const repos = await reposWithExists(effective.repos);
    // Ненайденный путь — предупреждение, а не отказ: репозиторий мог ещё не склонироваться,
    // и после восстановления из архива об этом стоит сказать сразу.
    const missing = repos
      .filter((repo) => !repo.exists)
      .map((repo) => `Каталог ${repo.dir} не найден.`);

    return {
      id,
      title: record?.title ?? id,
      tags: record?.tags ?? [],
      repos,
      defaultRepoKey: record?.defaultRepoKey ?? null,
      archivedAt: record?.archivedAt ?? null,
      revision: record?.revision ?? 0,
      updatedAt: record?.updatedAt ?? null,
      profile: { present: profile.present, pathsSource: effective.pathsSource },
      importStatus: record?.import.status ?? 'none',
      routes: await routesOf(id),
      warnings: [...warningsOf(effective.repos), ...missing],
    };
  }

  async function detailOf(
    id: string,
    record: ProjectRecord | null,
    profile: ProfileState,
  ): Promise<ProjectDetail> {
    const summary = await summaryOf(id, record, profile);

    return {
      ...summary,
      description: record?.description ?? '',
      createdAt: record?.createdAt ?? null,
      import: record?.import ?? { ...EMPTY_IMPORT },
      profile: {
        ...summary.profile,
        readable: profile.readable,
        repos: profile.repos,
        capabilities: profile.capabilities,
        // Ключи паспорта без источника в профиле — диагностика инкремента B.
        mismatch: [],
      },
    };
  }

  // Порт чтения реестра: внутри очереди читаем ровно тот снимок файла, на основе
  // которого собираемся писать, а не свежий read() с overlay умолчаний.
  function storedPort(stored: Record<string, unknown>) {
    return { read: () => stored };
  }

  function storedProjectsOf(stored: Record<string, unknown>): Record<string, unknown> {
    return asRecord(stored.projects);
  }

  function rawRecordOf(stored: Record<string, unknown>, id: string): Record<string, unknown> {
    return asRecord(storedProjectsOf(stored)[id]);
  }

  async function list(): Promise<ProjectSummary[]> {
    // Список — чтение: нечитаемый файл настроек не должен гасить раздел целиком.
    const stored = prefs.read();
    const port = storedPort(stored);
    const factorySet = await factoryIds();
    const ids = await listProjects(config, prefs);
    const profiles = await Promise.all(ids.map((id) => profileStateOf(id, factorySet.has(id))));

    // Профили читались тем же порядком, что и ids: индекс один и тот же.
    return Promise.all(ids.map((id, index) => (
      summaryOf(id, readProjectRecord(port, id), profiles[index] ?? ABSENT_PROFILE)
    )));
  }

  async function read(id: string): Promise<ProjectDetail> {
    requireId(id);

    // Паспорт читается из фактического файла: если файл не читается, показать проект
    // нельзя — это отказ записи настроек, а не «проекта нет».
    const stored = prefs.readForWrite();
    const record = readProjectRecord(storedPort(stored), id);
    const factorySet = await factoryIds();

    if (record === null && !factorySet.has(id)) {
      throw new ProjectsError(404, 'not_found', `Проект «${id}» не найден.`);
    }

    return detailOf(id, record, await profileStateOf(id, factorySet.has(id)));
  }

  async function create(input: unknown): Promise<ProjectDetail> {
    const value = validated(input, { creating: true });
    const id = String(value.id);

    return mutate(async () => {
      const stored = prefs.readForWrite();
      const port = storedPort(stored);

      if (readProjectRecord(port, id)) {
        throw new ProjectsError(409, 'exists', `Проект «${id}» уже есть в реестре.`);
      }
      if ((await factoryIds()).has(id)) {
        throw new ProjectsError(409, 'exists', `Профиль «${id}» уже есть в profiles/ фабрики.`);
      }

      const at = now();
      const record: ProjectRecord = {
        title: value.title,
        description: value.description,
        tags: value.tags,
        repos: normalizedRepos(value.repos),
        defaultRepoKey: value.defaultRepoKey,
        archivedAt: null,
        import: { ...EMPTY_IMPORT },
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };

      prefs.write({ projects: { ...storedProjectsOf(stored), [id]: record } });
      announce({ id, revision: record.revision, kind: 'created' });

      return detailOf(id, record, ABSENT_PROFILE);
    });
  }

  async function update(
    id: string,
    input: unknown,
    expectedRevision: unknown,
  ): Promise<ProjectDetail> {
    requireId(id);
    const value = validated(input, { creating: false });

    return mutate(async () => {
      const revision = requireRevision(expectedRevision);
      const stored = prefs.readForWrite();
      const port = storedPort(stored);
      const record = readProjectRecord(port, id);
      const profile = await profileStateOf(id, (await factoryIds()).has(id));

      if (record === null && !profile.present) {
        throw new ProjectsError(404, 'not_found', `Проект «${id}» не найден.`);
      }
      if (record?.archivedAt) {
        throw new ProjectsError(409, 'archived', 'Проект в архиве: сначала верните его из архива.');
      }

      const currentRevision = record?.revision ?? 0;

      if (revision !== currentRevision) {
        throw new ProjectsError(
          409,
          'revision_conflict',
          'Паспорт изменился после того, как форма его прочитала.',
          { currentRevision },
        );
      }

      // Правило инкремента A: у проекта фабрики с непустым PROFILE_TRIAGE_REPOS пути
      // задаёт профиль. Остальные поля правятся — их у профиля нет.
      if (profile.present && profile.repos.length && !sameRepos(value.repos, profile.repos)) {
        throw new ProjectsError(
          409,
          'factory_project',
          'Пути этого проекта задаёт профиль фабрики (PROFILE_TRIAGE_REPOS) — правьте их там.',
        );
      }

      const at = now();
      const next = {
        // Неизвестные внутренние поля записи сохраняются: их могло положить будущее
        // поле или соседний читатель, и терять их при правке названия нельзя.
        ...rawRecordOf(stored, id),
        title: value.title,
        description: value.description,
        tags: value.tags,
        repos: normalizedRepos(value.repos),
        defaultRepoKey: value.defaultRepoKey,
        archivedAt: record?.archivedAt ?? null,
        import: record?.import ?? { ...EMPTY_IMPORT },
        revision: currentRevision + 1,
        createdAt: record?.createdAt ?? at,
        updatedAt: at,
      };

      prefs.write({ projects: { ...storedProjectsOf(stored), [id]: next } });
      announce({ id, revision: next.revision, kind: 'updated' });

      return detailOf(id, next, profile);
    });
  }

  /**
   * Поля записи для мутации. У профиля без записи паспорта ещё нет — он собирается
   * так же, как при чтении: иначе архивация профиля создала бы запись без названия,
   * путей и даты создания.
   */
  function fieldsForWrite(
    record: ProjectRecord | null,
    profile: ProfileState,
    id: string,
    at: string,
  ) {
    const effective = effectiveRepos(record, profile);

    return {
      title: record?.title ?? id,
      description: record?.description ?? '',
      tags: record?.tags ?? [],
      repos: effective.repos.map((repo) => ({ ...repo })),
      defaultRepoKey: record?.defaultRepoKey ?? null,
      import: record?.import ?? { ...EMPTY_IMPORT },
      createdAt: record?.createdAt ?? at,
      updatedAt: at,
    };
  }

  /**
   * Сводка связей проекта: кто на него ссылается и можно ли поэтому его прятать
   * или удалять. Ошибка провайдера считается запретом: «не знаю» здесь означает
   * «нельзя», иначе проект исчез бы вместе с чужими ссылками.
   */
  async function dependencies(id: string): Promise<ProjectDependencies> {
    requireId(id);

    const items: ProjectDependencyItem[] = [];
    const reasons: string[] = [];
    let archivable = true;
    let checked = true;

    for (const provider of dependencyProviders) {
      try {
        const found = await provider.count(id);
        const count = Math.max(0, Math.trunc(Number(found?.count) || 0));

        if (count === 0) {
          continue;
        }

        items.push({
          kind: provider.kind,
          label: provider.label,
          count,
          items: (found.items ?? []).slice(0, DEPENDENCY_ITEMS_LIMIT),
        });

        if (provider.blocksArchive) {
          archivable = false;
          reasons.push(`${provider.label}: ${count}. Пока они ссылаются на проект, архив запрещён.`);
        }
      } catch (error) {
        archivable = false;
        checked = false;
        reasons.push(`Связи не проверены (${provider.label}): ${errorText(error)}`);
      }
    }

    const stored = prefs.readForWrite();
    const record = readProjectRecord(storedPort(stored), id);
    const profilePresent = (await factoryIds()).has(id);
    const archived = Boolean(record?.archivedAt);

    // Удалять можно только архивную запись, у которой нет профиля на диске (профиль —
    // территория движка) и на которую никто не ссылается.
    return {
      items,
      archivable,
      deletable: checked && archived && !profilePresent && items.length === 0,
      reasons,
    };
  }

  /** Архив: проект остаётся в реестре, но потребители его больше не предлагают. */
  async function archive(id: string, expectedRevision: unknown): Promise<ProjectDetail> {
    requireId(id);
    const revision = requireRevision(expectedRevision);

    return mutate(async () => {
      const stored = prefs.readForWrite();
      const record = readProjectRecord(storedPort(stored), id);
      const profile = await profileStateOf(id, (await factoryIds()).has(id));

      if (record === null && !profile.present) {
        throw new ProjectsError(404, 'not_found', `Проект «${id}» не найден.`);
      }
      if (record?.archivedAt) {
        throw new ProjectsError(409, 'archived', 'Проект уже в архиве.');
      }

      const currentRevision = record?.revision ?? 0;

      if (revision !== currentRevision) {
        throw new ProjectsError(
          409,
          'revision_conflict',
          'Паспорт изменился после того, как форма его прочитала.',
          { currentRevision },
        );
      }

      const summary = await dependencies(id);

      if (!summary.archivable) {
        throw new ProjectsError(
          409,
          'active_rules',
          summary.reasons.join(' ') || 'Проект связан с другими разделами.',
        );
      }

      const at = now();
      const next = {
        ...rawRecordOf(stored, id),
        ...fieldsForWrite(record, profile, id, at),
        archivedAt: at,
        revision: currentRevision + 1,
      };

      prefs.write({ projects: { ...storedProjectsOf(stored), [id]: next } });
      announce({ id, revision: next.revision, kind: 'archived' });

      return detailOf(id, next, profile);
    });
  }

  /** Возврат из архива: путь и ревизия те же, проект снова доступен потребителям. */
  async function restore(id: string, expectedRevision: unknown): Promise<ProjectDetail> {
    requireId(id);
    const revision = requireRevision(expectedRevision);

    return mutate(async () => {
      const stored = prefs.readForWrite();
      const record = readProjectRecord(storedPort(stored), id);
      const profile = await profileStateOf(id, (await factoryIds()).has(id));

      if (!record?.archivedAt) {
        throw new ProjectsError(409, 'not_archived', `Проект «${id}» не в архиве.`);
      }

      const currentRevision = record.revision;

      if (revision !== currentRevision) {
        throw new ProjectsError(
          409,
          'revision_conflict',
          'Паспорт изменился после того, как форма его прочитала.',
          { currentRevision },
        );
      }

      const at = now();
      const next = {
        ...rawRecordOf(stored, id),
        ...fieldsForWrite(record, profile, id, at),
        archivedAt: null,
        revision: currentRevision + 1,
      };

      prefs.write({ projects: { ...storedProjectsOf(stored), [id]: next } });
      announce({ id, revision: next.revision, kind: 'restored' });

      return detailOf(id, next, profile);
    });
  }

  function registerDependencyProvider(provider: ProjectDependencyProvider): void {
    dependencyProviders.push(provider);
  }

  /** Проверка путей без сохранения: паспорт при ней не меняется. */
  async function checkRepositories(dirs: string[]): Promise<RepositoryCheckResult[]> {
    return checkRepositoryPaths(dirs, { concurrency: 4 });
  }

  function onChange(listener: (change: ProjectsChange) => void): () => void {
    listeners.add(listener);

    return () => listeners.delete(listener);
  }

  return {
    list,
    read,
    create,
    update,
    archive,
    restore,
    dependencies,
    registerDependencyProvider,
    checkRepositories,
    onChange,
  };
}
