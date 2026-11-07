// Хранилище роликов. Каталог задаёт config, структура внутри — одна запись ролика
// плюс её артефакты; временные файлы попытки лежат отдельно и в актуальные ссылки
// не попадают, пока результат не проверен.
//
// Три правила, из-за которых это отдельный модуль:
//  • запись атомарна и идёт целиком — недописанный JSON после падения неотличим
//    от повреждённого, а раздел обязан их различать;
//  • изменения одного ролика выстроены в очередь, и каждое приходит со своей
//    ожидаемой редакцией: правка из второй вкладки не затирается молча;
//  • повреждённый файл сохраняется рядом и даёт ошибку чтения. Обнулить его —
//    значит потерять единственную копию работы человека ради чистого списка.
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  parseShowcaseProject,
  SHOWCASE_ID_RE,
  SHOWCASE_SCHEMA_VERSION,
} from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import type { ShowcaseProject } from '../../../../shared/plugins/showcase/showcaseContracts.ts';
import { notFound, revisionConflict, ShowcaseError } from './errors.ts';
import { extensionOf } from './formats.ts';

export interface ShowcaseStoreOptions {
  showcaseDir: string;
}

interface ProjectFileNames {
  dir: string;
  file: string;
  scenesDir: string;
  finalsDir: string;
}

/** Идентификатор ролика: случайный, короткий и пригодный для имени каталога. */
export function newShowcaseId(): string {
  return randomBytes(8).toString('hex');
}

function assertId(id: string): void {
  if (!SHOWCASE_ID_RE.test(id)) {
    throw new ShowcaseError('bad_id', 'Идентификатор ролика имеет недопустимую форму.', 400);
  }
}

export function createShowcaseStore({ showcaseDir }: ShowcaseStoreOptions) {
  const projectsDir = path.join(showcaseDir, 'projects');
  const jobsDir = path.join(showcaseDir, 'jobs');

  // Очередь на ролик: последовательность изменений одной записи. Без неё две
  // одновременные правки читали бы одну редакцию и вторая затирала бы первую,
  // хотя обе пришли с корректной ожидаемой редакцией.
  const queues = new Map<string, Promise<unknown>>();

  function namesOf(id: string): ProjectFileNames {
    const dir = path.join(projectsDir, id);

    return {
      dir,
      file: path.join(dir, 'project.json'),
      scenesDir: path.join(dir, 'scenes'),
      finalsDir: path.join(dir, 'finals'),
    };
  }

  /**
   * Запись во временный файл и переименование: читатель видит либо прошлую версию
   * целиком, либо новую целиком. Права 0600 — в записи ролика есть отпечатки цели
   * и решения человека, и общего доступа им не нужно.
   */
  async function writeJson(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`;

    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, file);
  }

  /**
   * Повреждённый файл переносится рядом с меткой времени и заменяется ошибкой
   * чтения. Ролик мог собираться час, и его единственная запись не должна тихо
   * исчезнуть из-за одного неполного сохранения.
   */
  async function quarantine(file: string, reason: string): Promise<never> {
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const broken = `${file}.broken-${stamp}`;

    await fs.rename(file, broken).catch(() => null);

    throw new ShowcaseError(
      'corrupted',
      `Запись ролика повреждена и сохранена для разбора: ${path.basename(broken)}. ${reason}`,
      500,
    );
  }

  async function readProject(id: string): Promise<ShowcaseProject> {
    assertId(id);

    const { file } = namesOf(id);
    let text = '';

    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      throw notFound('Ролик не найден.');
    }

    let value: unknown;

    try {
      value = JSON.parse(text);
    } catch {
      return quarantine(file, 'Файл не является JSON.');
    }

    // Версия проверяется до декодера: запись будущей версии не «повреждённая»,
    // и предлагать по ней разбор поломки было бы неправдой.
    const version = (value as { schemaVersion?: unknown })?.schemaVersion;

    if (version !== SHOWCASE_SCHEMA_VERSION) {
      throw new ShowcaseError(
        'schema_mismatch',
        `Ролик сохранён схемой версии ${String(version)}, раздел работает со схемой ${SHOWCASE_SCHEMA_VERSION}.`,
        409,
      );
    }

    try {
      return parseShowcaseProject(value);
    } catch (error) {
      return quarantine(file, String((error as Error).message ?? ''));
    }
  }

  /**
   * Изменение ролика: очередь на его идентификатор, проверка ожидаемой редакции
   * и атомарная запись с увеличенной редакцией. Ожидаемая редакция `null` — это
   * служебные изменения самого сервера, которые не спорят с правкой человека:
   * публикация результата задания и пометка устаревания.
   */
  async function updateProject(
    id: string,
    expectedRevision: number | null,
    mutate: (project: ShowcaseProject) => ShowcaseProject | Promise<ShowcaseProject>,
  ): Promise<ShowcaseProject> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => null).then(async () => {
      const current = await readProject(id);

      if (expectedRevision !== null && expectedRevision !== current.revision) {
        throw revisionConflict(current.revision);
      }

      const changed = await mutate(current);
      const saved: ShowcaseProject = {
        ...changed,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };

      await writeJson(namesOf(id).file, saved);

      return saved;
    });

    queues.set(id, next.catch(() => null));

    return next;
  }

  async function createProject(project: ShowcaseProject): Promise<ShowcaseProject> {
    const names = namesOf(project.id);

    await fs.mkdir(names.scenesDir, { recursive: true });
    await fs.mkdir(names.finalsDir, { recursive: true });

    // Исключительное создание: повторный запрос с тем же идентификатором не
    // затирает уже начатую работу, даже если он пришёл из двойного клика.
    const handle = await fs.open(names.file, 'wx', 0o600).catch(() => null);

    if (!handle) {
      throw new ShowcaseError('already_exists', 'Ролик с таким идентификатором уже есть.', 409);
    }

    await handle.close();
    await writeJson(names.file, project);

    return project;
  }

  /**
   * Удаляет только узнаваемые неизменяемые артефакты, которые больше не достижимы
   * из project.json и уже пережили общий retention. Свежий непринятый результат
   * гонки остаётся до следующего прохода, поэтому публикация не спорит с уборкой.
   */
  async function sweepUnreferencedArtifacts(
    project: ShowcaseProject,
    beforeMs: number,
  ): Promise<number> {
    const names = namesOf(project.id);
    const keep = new Set<string>();

    for (const scene of project.scenes) {
      for (const media of [scene.audio, scene.clip, scene.frame]) {
        if (media) {
          keep.add(path.join(names.scenesDir, scene.id, 'artifacts', `${media.id}${extensionOf(media.kind)}`));
        }
      }

      for (const derived of [scene.speechTiming, scene.speechAlignment, scene.recordingTiming]) {
        if (derived) {
          keep.add(path.join(names.scenesDir, scene.id, 'artifacts', `${derived.id}.json`));
        }
      }
    }

    if (project.latestFinal) {
      keep.add(path.join(
        names.finalsDir,
        `${project.latestFinal.video.id}${extensionOf(project.latestFinal.video.kind)}`,
      ));

      if (project.latestFinal.subtitles) {
        keep.add(path.join(
          names.finalsDir,
          `${project.latestFinal.subtitles.id}${extensionOf(project.latestFinal.subtitles.kind)}`,
        ));
      }

      if (project.latestFinal.manifestVersion === 1) {
        keep.add(path.join(names.finalsDir, `${project.latestFinal.manifestId}.json`));
      }
    }

    const candidates: string[] = [];
    const sceneEntries = await fs.readdir(names.scenesDir, { withFileTypes: true }).catch(() => []);

    for (const sceneEntry of sceneEntries) {
      if (!sceneEntry.isDirectory()) {
        continue;
      }

      const artifactsDir = path.join(names.scenesDir, sceneEntry.name, 'artifacts');
      const entries = await fs.readdir(artifactsDir, { withFileTypes: true }).catch(() => []);

      for (const entry of entries) {
        if (entry.isFile() && /^(?:(?:audio|clip|frame)-[a-f0-9]{12}\.(?:wav|webm|png|jpg)|(?:speech-timing|speech-alignment|recording-timing)-[a-f0-9]{12}\.json)$/.test(entry.name)) {
          candidates.push(path.join(artifactsDir, entry.name));
        }
      }
    }

    const finalEntries = await fs.readdir(names.finalsDir, { withFileTypes: true }).catch(() => []);

    for (const entry of finalEntries) {
      if (entry.isFile() && /^(?:(?:final|subtitles)-[a-f0-9]{12}\.(?:mp4|srt)|manifest-[a-f0-9]{32}\.json)$/.test(entry.name)) {
        candidates.push(path.join(names.finalsDir, entry.name));
      }
    }

    let removed = 0;

    for (const file of candidates) {
      if (keep.has(file)) {
        continue;
      }

      const info = await fs.stat(file).catch(() => null);

      if (info?.isFile() && info.mtimeMs < beforeMs) {
        await fs.rm(file, { force: true });
        removed += 1;
      }
    }

    return removed;
  }

  /**
   * Список роликов. Повреждённая или чужой версии запись не роняет весь список:
   * она возвращается отдельной строкой с причиной, потому что раздел обязан
   * показать, что такая запись есть, и не притворяться, что роликов меньше.
   */
  async function listProjects(): Promise<{
    projects: ShowcaseProject[];
    unreadable: { id: string; reason: string }[];
  }> {
    let names: string[] = [];

    try {
      names = await fs.readdir(projectsDir);
    } catch {
      return { projects: [], unreadable: [] };
    }

    const projects: ShowcaseProject[] = [];
    const unreadable: { id: string; reason: string }[] = [];

    for (const id of names.filter((name) => SHOWCASE_ID_RE.test(name))) {
      try {
        projects.push(await readProject(id));
      } catch (error) {
        unreadable.push({ id, reason: String((error as Error).message ?? '') });
      }
    }

    projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    return { projects, unreadable };
  }

  /**
   * Удаление ролика. Каталог сносится целиком вместе с артефактами; отмену
   * заданий и освобождение ссылок делает служба до вызова — хранилище не решает,
   * можно ли удалять то, над чем ещё идёт работа.
   */
  async function removeProject(id: string): Promise<void> {
    assertId(id);
    await fs.rm(namesOf(id).dir, { recursive: true, force: true });
    queues.delete(id);
  }

  async function ensureDirs(): Promise<void> {
    await fs.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(jobsDir, { recursive: true, mode: 0o700 });
  }

  return {
    createProject,
    ensureDirs,
    jobsDir,
    listProjects,
    namesOf,
    projectsDir,
    readProject,
    removeProject,
    sweepUnreferencedArtifacts,
    updateProject,
    writeJson,
  };
}

export type ShowcaseStore = ReturnType<typeof createShowcaseStore>;
