import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Фикстура получает только путь к системным бинарникам и временную папку.
 * Git-конфигурация задаётся явно ниже, переменные credentials машины не наследуются.
 */
export function fixtureGitEnv() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: os.tmpdir(),
  };
}

/**
 * git в тестах — на английском и без глобальных настроек машины: иначе текст ошибок
 * и прогресса зависел бы от локали и ~/.gitconfig разработчика.
 */
export async function git(cwd, ...args) {
  const { stdout } = await exec('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      // fixtureGitEnv убирает GIT_*/ASKPASS/trace/NODE_OPTIONS и настройки машины;
      // отрицательные security fixtures добавляют только собственные вредные overrides.
      ...fixtureGitEnv(),
      LC_ALL: 'C',
      LANGUAGE: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });

  return stdout.trim();
}

/**
 * Репозиторий плагина для тестов установки: рабочая копия и bare origin.
 * `release` пишет файлы версии, коммитит, ставит тег и публикует его в origin.
 */
export async function createPluginRepo(t, { id = 'demo', name = 'Демо' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-plugin-repo-'));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');

  t.after(() => rm(root, { recursive: true, force: true }));

  await git(root, 'init', '-q', '-b', 'main', work);
  await git(work, 'config', 'user.name', 'GrigDesk Test');
  await git(work, 'config', 'user.email', 'grigdesk@example.invalid');
  await git(root, 'init', '-q', '--bare', origin);
  await git(work, 'remote', 'add', 'origin', origin);

  /**
   * Одна версия пакета: manifest дополняет plugin.json, files — прочие файлы.
   * Простой тег нужен проверке разбора ls-remote; по умолчанию тег аннотированный.
   */
  async function release(version, { manifest = {}, files = {}, lightweight = false } = {}) {
    const all = {
      'plugin.json': JSON.stringify({
        id,
        name,
        api: 1,
        version,
        description: 'Тестовый плагин',
        ...manifest,
      }, null, 2),
      ...files,
    };

    for (const [file, body] of Object.entries(all)) {
      const target = path.join(work, file);

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, 'utf8');
    }

    await git(work, 'add', '-A');
    await git(work, 'commit', '-q', '-m', `release ${version}`);

    if (lightweight) {
      await git(work, 'tag', `v${version}`);
    } else {
      await git(work, 'tag', '-a', `v${version}`, '-m', `v${version}`);
    }

    await git(work, 'push', '-q', 'origin', 'main', '--tags');

    return git(work, 'rev-parse', 'HEAD');
  }

  return {
    root,
    work,
    origin,
    url: pathToFileURL(origin).href,
    release,
  };
}
