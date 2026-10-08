// Код, который читают триаж и арбитр его вопросов.
//
// Конвейер isolated-профиля начинает задачу с новой ветки от интеграционной ветки origin,
// а основная рабочая копия проекта принадлежит человеку: она стоит на ветке задачи или на
// отделённом HEAD многонедельной давности, и обновление перед запуском её законно не трогает
// (pull только на чистом master). Поэтому isolated-триаж читает собственный снимок той ветки,
// от которой стартует конвейер: detached worktree в каталоге кокпита. Рабочие копии человека
// при этом не читаются и не меняются. Shared-конвейер работает прямо в рабочей копии — её
// триаж и читает, как раньше.
//
// Снимок один на репозиторий и сдвигается на новый коммит, только когда его никто не читает:
// агент посреди разведки не должен видеть, как под ним меняются файлы. Сбой подготовки
// снимка роняет заход с причиной — молча читать вместо него старый код нельзя.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { REPOSITORY_RE } from '../factoryLaunchContract.ts';
import { git } from '../gitRefresh.ts';
import type { GitRun } from '../gitRefresh.ts';
import { withPathLock } from '../pathLock.ts';
import { PROFILE_RE } from '../profiles.ts';
import type { TriageProfile, TriageRepo } from './profile.ts';

// Код одного репозитория для захода: что читает агент и на какой ревизии.
export interface TriageSourceRepo {
  key: string;
  // Каталог, который читает агент: снимок или рабочая копия.
  dir: string;
  // Рабочая копия из PROFILE_TRIAGE_REPOS: по ней форма запуска узнаёт профиль оценки.
  source: string;
  sha: string | null;
  // Ветка снимка (`origin/master`); null — агент читает рабочую копию.
  ref: string | null;
  // Почему isolated-заход читает рабочую копию или почему снимок отстал от ветки.
  note: string;
}

export type TriageSourceProfile = Pick<TriageProfile, 'cwd' | 'dirs' | 'repos' | 'workspaceMode'> & {
  name: string;
};

// Код на один заход: репозитории и каталоги, открытые агенту на чтение. release снимает
// аренду снимков, повторный вызов ничего не делает.
export interface TriageSourceLease {
  repos: TriageSourceRepo[];
  roots: string[];
  release(): void;
}

// Готовый снимок: каталог, его ревизия и ветка, от которой он снят.
interface Snapshot {
  dir: string;
  sha: string;
  ref: string;
  note: string;
}

const NO_ORIGIN_NOTE = 'у репозитория нет origin/HEAD, origin/master или origin/main';
// Хуки рабочей копии человека не срабатывают на служебный checkout снимка.
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
// Снимку нужен код, а не LFS-содержимое: smudge полез бы в сеть.
const SNAPSHOT_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
const CHECKOUT_TIMEOUT_MS = 120_000;

function snapshotGit(dir: string, args: string[], timeout = 30_000): Promise<GitRun> {
  return git(dir, args, timeout, SNAPSHOT_GIT_ENV);
}

async function headSha(dir: string): Promise<string | null> {
  const head = await snapshotGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);

  return head.ok && head.out ? head.out : null;
}

async function commonDirOf(dir: string): Promise<string | null> {
  const common = await snapshotGit(dir, ['rev-parse', '--git-common-dir']);

  return common.ok && common.out
    ? fs.realpath(path.resolve(dir, common.out)).catch(() => null)
    : null;
}

/**
 * Ветка, от которой isolated-конвейер заводит задачу: `origin/HEAD`, иначе
 * `origin/master` или `origin/main` (docs/engine/PROFILE-CONTRACT.md).
 */
async function integrationRef(source: string): Promise<string | null> {
  const head = await snapshotGit(source, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);

  if (head.ok && head.out) {
    return head.out;
  }

  for (const name of ['master', 'main']) {
    const found = await snapshotGit(source, [
      'show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`,
    ]);

    if (found.ok) {
      return `origin/${name}`;
    }
  }

  return null;
}

/**
 * Ревизия снимка, если каталог — worktree того же репозитория. Чужой или сломанный
 * каталог даёт null: его пересоздают, а не читают.
 */
async function snapshotHead(dir: string, commonDir: string): Promise<string | null> {
  const marker = await fs.lstat(path.join(dir, '.git')).catch(() => null);

  if (!marker?.isFile() || await commonDirOf(dir) !== commonDir) {
    return null;
  }

  return headSha(dir);
}

/**
 * Убирает каталог снимка. Регистрацию worktree снимает сам Git; если каталог уже
 * не его, удаляется только каталог снимка — чужие регистрации не трогаются.
 */
async function removeSnapshot(dir: string, source: string): Promise<void> {
  const removed = await snapshotGit(source, ['worktree', 'remove', '--force', '--force', dir]);

  if (!removed.ok) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export class TriageSources {
  root: string;

  // Сколько заходов сейчас читают снимок: занятый снимок не сдвигается.
  _readers = new Map<string, number>();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Выдаёт заходу код для чтения. Isolated-профиль получает снимки интеграционной ветки,
   * shared и профиль без режима — рабочие копии и каталоги агента профиля, как раньше.
   * Сбой подготовки снимка снимает уже взятые аренды и роняет заход с причиной.
   */
  async acquire(profile: TriageSourceProfile): Promise<TriageSourceLease> {
    const held: string[] = [];
    const release = () => this._release(held);
    const repos: TriageSourceRepo[] = [];

    try {
      for (const repo of profile.repos) {
        repos.push(await this._repoSource(profile, repo, held));
      }
    } catch (error) {
      release();

      throw error;
    }

    // Isolated-заходу открыт только его код: каталоги агента профиля там — рабочие копии
    // и worktree людей со старым кодом.
    const own = profile.workspaceMode === 'isolated' ? [] : [profile.cwd, ...profile.dirs];

    return {
      repos,
      roots: [...own, ...repos.map((repo) => repo.dir)].filter(Boolean),
      release,
    };
  }

  /**
   * Снимает аренду снимков захода. splice опустошает список: повторный вызов ничего
   * не снимает, а снимок без читателей следующий заход снова может сдвинуть.
   */
  _release(held: string[]): void {
    for (const dir of held.splice(0)) {
      const left = (this._readers.get(dir) || 1) - 1;

      if (left > 0) {
        this._readers.set(dir, left);
      } else {
        this._readers.delete(dir);
      }
    }
  }

  /**
   * Код одного репозитория: снимок для isolated-профиля, иначе рабочая копия. Isolated
   * без ссылок origin тоже читает рабочую копию — от её HEAD профили и заводят задачу.
   */
  async _repoSource(
    profile: TriageSourceProfile,
    repo: TriageRepo,
    held: string[],
  ): Promise<TriageSourceRepo> {
    const isolated = profile.workspaceMode === 'isolated';
    const snapshot = isolated ? await this._lease(profile.name, repo) : null;

    if (snapshot) {
      held.push(snapshot.dir);

      return {
        key: repo.key,
        dir: snapshot.dir,
        source: repo.dir,
        sha: snapshot.sha,
        ref: snapshot.ref,
        note: snapshot.note,
      };
    }

    return {
      key: repo.key,
      dir: repo.dir,
      source: repo.dir,
      sha: await headSha(repo.dir),
      ref: null,
      note: isolated ? NO_ORIGIN_NOTE : '',
    };
  }

  /**
   * Готовит снимок под очередью его каталога и записывает читателя. null — у
   * репозитория нет ссылок origin; любой другой сбой — исключение с причиной.
   */
  async _lease(profileName: string, repo: TriageRepo): Promise<Snapshot | null> {
    if (!PROFILE_RE.test(profileName) || !REPOSITORY_RE.test(repo.key)) {
      throw new Error(`снимок ${repo.key}: имя профиля или репозитория не годится для каталога`);
    }

    const dir = path.join(this.root, profileName, `triage-${repo.key}`);

    return withPathLock(dir, async () => {
      const snapshot = await this._prepare(dir, repo).catch((error: unknown) => {
        const reason = String((error as Error)?.message || error).slice(0, 200);

        throw new Error(`снимок ${repo.key} не подготовлен: ${reason}`);
      });

      if (snapshot) {
        this._readers.set(dir, (this._readers.get(dir) || 0) + 1);
      }

      return snapshot;
    });
  }

  /**
   * Приводит снимок к текущей интеграционной ветке. Занятый соседним заходом снимок
   * не сдвигается, сломанный пересоздаётся. null — у репозитория нет ссылок origin.
   */
  async _prepare(dir: string, repo: TriageRepo): Promise<Snapshot | null> {
    const common = await commonDirOf(repo.dir);

    if (!common) {
      throw new Error('каталог репозитория не читается как Git');
    }

    const ref = await integrationRef(repo.dir);

    if (!ref) {
      return null;
    }

    const target = await snapshotGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

    if (!target.ok || !target.out) {
      throw new Error(`не читается ${ref}`);
    }

    const current = await snapshotHead(dir, common);
    const ready: Snapshot = {
      dir,
      sha: target.out,
      ref,
      note: '',
    };

    if (current === ready.sha) {
      return ready;
    }

    if (current && this._readers.get(dir)) {
      return {
        ...ready,
        sha: current,
        note: `${ref} ушла вперёд, но снимок читает соседний заход`,
      };
    }

    const moved = current !== null && (await snapshotGit(dir, [
      ...NO_HOOKS, 'checkout', '--quiet', '--detach', '--force', ready.sha,
    ], CHECKOUT_TIMEOUT_MS)).ok;

    if (moved) {
      return ready;
    }

    await removeSnapshot(dir, repo.dir);
    await fs.mkdir(path.dirname(dir), { recursive: true });

    const added = await snapshotGit(repo.dir, [
      ...NO_HOOKS, 'worktree', 'add', '--quiet', '--force', '--detach', dir, ready.sha,
    ], CHECKOUT_TIMEOUT_MS);

    if (!added.ok) {
      throw new Error(`git worktree add: ${added.err.slice(0, 160)}`);
    }

    return ready;
  }
}
