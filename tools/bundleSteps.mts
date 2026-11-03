import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BuildStepEvent } from '../shared/node/buildStepEvents.ts';
import { acquireDirectoryLock } from '../shared/node/directoryLock.ts';
import { sha256File } from '../shared/node/hash.ts';
import { auditStage, normalizeStageModes } from '../server/scripts/sea/stage.mts';

const execute = promisify(execFile);
const payload = [
  'GrigDesk', 'README.md', 'bin/b24', 'bin/deepseek', 'bin/grigdesk-ctl',
  'bin/grigdesk-relay', 'bin/grigdesk-server', 'bin/lib/runtime-env.sh',
];
const executables = payload.filter((file) => !file.endsWith('.md') && !file.endsWith('.sh'));

type Stage = 'server' | 'b24' | 'relay' | 'deepseek' | 'window';

export interface BundleBuildInput {
  outDir: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
}

interface BundleOptions {
  root: string;
  onStep?(event: BuildStepEvent): void;
  env?: NodeJS.ProcessEnv;
  builders: Record<Stage, (input: BundleBuildInput) => Promise<string>>;
  readSourceState?(): Promise<{ commit: string; dirty: boolean }>;
  verifyDeepSeek(binary: string, env: NodeJS.ProcessEnv): Promise<void>;
  verifyDeepSeekCompatibility(binary: string, env: NodeJS.ProcessEnv): Promise<void>;
  audit?(root: string): Promise<void>;
  /**
   * Подпись ed25519 точного текста release.tar.gz.sha256: закрывает архив и опись
   * bundle.json. Без подписи выпуск остаётся прежним трёхфайловым.
   */
  sign?(content: string): Promise<string>;
  run?: typeof execute;
  fs?: typeof fs;
}

const readme = `# GrigDesk

Требуется Linux x64 (x86_64), glibc 2.28+ и libfuse2 для AppImage
(libfuse2t64 на новых Ubuntu). Системный Node не нужен. Для bin/grigdesk-ctl
нужны Bash и Python3. CLI исполнителей и вход в свои учётные записи настраиваются
самостоятельно; DeepSeek включён, но доступ к его сервису остаётся вашим.
Дополнительные возможности могут требовать своих программ.

Закройте прежнее окно GrigDesk и откройте файл GrigDesk в этой папке.
Дождитесь подготовки сервера. Прежний выбор сервера сохраняется; другой сервер рядом
можно выбрать в списке машин. При исчезновении прежнего пути окно предложит перенос
автоматически с сообщением. При первом открытии один раз появится вопрос о меню приложений.
Приложение не ставит системные пакеты и не запрашивает sudo.

Перед сменой локальной установки дождитесь завершения ходов в чатах: свой сервер
останавливается штатно, незавершённые ходы могут прерваться, телефон временно потеряет связь.
Чужой сервер не останавливается. Переносите папку после закрытия окна и остановки своего сервера.
Ярлык содержит абсолютный Exec: после переноса запускайте GrigDesk напрямую и исправьте Exec
в своём grigdesk-portable.desktop. Вопрос повторно не появится; userData (профиль окна)
ради ярлыка удалять не нужно. Профиль хранит identity (личность), выбор и настройки окна.

Для передачи используйте release.tar.gz: архив сохраняет права на запуск.
Опись bin/bundle.json содержит версию, коммит, dirty, SHA256, размер и права каждого файла.
Сама опись не хеширует себя. Из родительской папки проверьте
sha256sum -c release.tar.gz.sha256, затем SHA256 каждого файла по описи.

Удаление: закройте окно, дождитесь остановки своего сервера, удалите папку и архив,
а также свой ярлык grigdesk-portable.desktop из пользовательского каталога applications
(XDG_DATA_HOME или ~/.local/share). Общие данные, чаты, прежняя установка и профиль окна
при этом сохраняются. Комплект не содержит личных данных, ключей, токенов и профилей сборщика.
`;

/**
 * Build и пробы получают отдельные HOME/D/XDG/cache без личных loader и token overrides.
 * Только путь инструментов и локаль приходят снаружи; все writable каталоги принадлежат staging.
 */
async function buildEnvironment(work: string, parent: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    PATH: parent.PATH ?? '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: path.join(work, 'home'),
    XDG_DATA_HOME: path.join(work, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(work, 'xdg-config'),
    XDG_CACHE_HOME: path.join(work, 'cache'),
    GRIGDESK_HOME: path.join(work, 'data'),
    TMPDIR: path.join(work, 'tmp'),
    npm_config_cache: path.join(work, 'npm-cache'),
  };

  for (const [key, directory] of Object.entries(env)) {
    if (key !== 'PATH' && key !== 'LANG' && directory) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
  }

  return env;
}

/**
 * Все имена выпуска (три базовых и подписанные добавки) публикуются после проверок.
 * При ошибке rename возвращаются прежние выходы.
 * Backup не удаляется при неудаче восстановления, чтобы ручное восстановление было возможно.
 */
async function publish(
  root: string, work: string, files: typeof fs, extra: string[] = [],
): Promise<void> {
  const names = ['release', 'release.tar.gz', 'release.tar.gz.sha256', ...extra];
  const backed: string[] = [];
  const installed: string[] = [];

  try {
    for (const name of names) {
      const target = path.join(root, name);

      if (await files.lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        }

        throw error;
      })) {
        await files.rename(target, path.join(work, `backup-${name}`));
        backed.push(name);
      }
    }

    for (const name of names) {
      await files.rename(path.join(work, name), path.join(root, name));
      installed.push(name);
    }
  } catch (error) {
    try {
      for (const name of installed.reverse()) {
        await files.rm(path.join(root, name), { recursive: true, force: true });
      }

      for (const name of backed.reverse()) {
        await files.rename(path.join(work, `backup-${name}`), path.join(root, name));
      }
    } catch (restoreError) {
      throw Object.assign(new Error(`Не удалось восстановить поставку; резерв сохранён: ${work}`, {
        cause: restoreError,
      }), { preserveWork: true });
    }

    throw error;
  }
}

/**
 * Свежие выходы сборщиков копируются по закрытому allowlist без чтения установленного bin.
 * Настоящий tar и повторный аудит распаковки завершаются до замены прежней поставки.
 */
export async function executeBundle(options: BundleOptions): Promise<void> {
  const root = path.resolve(options.root);
  const files = options.fs ?? fs;
  const run = options.run ?? execute;
  const lock = await acquireDirectoryLock(path.join(root, '.grigdesk-bundle.lock'));
  let work: string | undefined;
  let preserve = false;

  /**
   * Наблюдение обрамляет прежнюю фазу и не скрывает её исходную ошибку.
   * После отказа end содержит код ребёнка, следующие фазы не запускаются.
   */
  async function step<T>(id: string, action: () => Promise<T>): Promise<T> {
    options.onStep?.({ type: 'start', id });

    try {
      const result = await action();

      options.onStep?.({
        type: 'end',
        id,
        code: 0,
      });

      return result;
    } catch (error) {
      const code = Number((error as { code?: unknown }).code);

      options.onStep?.({
        type: 'end',
        id,
        code: Number.isInteger(code) && code > 0 ? code : 1,
      });

      throw error;
    }
  }

  try {
    const source = options.readSourceState ? await options.readSourceState() : {
      commit: (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
      dirty: (await execute('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: root,
      })).stdout.length > 0,
    };
    const version = (await files.readFile(path.join(root, 'VERSION'), 'utf8')).trim();

    work = await files.mkdtemp(path.join(root, '.grigdesk-bundle-'));

    const env = await buildEnvironment(work, options.env ?? process.env);
    const stage = path.join(work, 'release');
    const targets: Record<Stage, string> = {
      server: 'bin/grigdesk-server',
      b24: 'bin/b24',
      relay: 'bin/grigdesk-relay',
      deepseek: 'bin/deepseek',
      window: 'GrigDesk',
    };

    await files.mkdir(path.join(stage, 'bin/lib'), { recursive: true });

    for (const name of Object.keys(targets) as Stage[]) {
      await step(`bundle.${name}`, async () => {
        const outDir = path.join(work!, 'build', name);
        const cacheDir = path.join(work!, 'cache', name);

        await files.mkdir(outDir, { recursive: true });
        await files.mkdir(cacheDir, { recursive: true });

        const output = await options.builders[name]({
          outDir,
          cacheDir,
          env,
        });
        const physical = await files.realpath(output);

        if (!physical.startsWith(outDir + path.sep) || !(await files.lstat(output)).isFile()) {
          throw new Error(`Сборщик ${name} вернул чужой выход`);
        }

        await files.copyFile(output, path.join(stage, targets[name]));
      });
    }

    const deepseek = path.join(stage, 'bin/deepseek');

    await step('bundle.verify', async () => {
      await options.verifyDeepSeek(deepseek, env);
      await options.verifyDeepSeekCompatibility(deepseek, env);
    });
    await step('bundle.pack', async () => {
      await files.copyFile(path.join(root, 'bin/grigdesk-ctl'), path.join(stage, 'bin/grigdesk-ctl'));
      await files.copyFile(path.join(root, 'deploy/lib/runtime-env.sh'),
        path.join(stage, 'bin/lib/runtime-env.sh'));
      await files.writeFile(path.join(stage, 'README.md'), readme);

      for (const relative of payload) {
        await files.chmod(path.join(stage, relative), executables.includes(relative) ? 0o755 : 0o644);
      }

      await normalizeStageModes(stage);

      const inventory = await auditStage(stage, { required: payload, executables });

      if (inventory.length !== payload.length || inventory.some((file) => file.type !== 'file'
        || !payload.includes(file.path))) {
        throw new Error('Состав переносимой поставки не совпадает с allowlist');
      }

      await options.audit?.(stage);
      await files.writeFile(path.join(stage, 'bin/bundle.json'), JSON.stringify({
        format: 1,
        kind: 'portable',
        version,
        ...source,
        files: inventory.map(({ type: _type, ...entry }) => entry),
      }, null, 2) + '\n', { mode: 0o644 });

      const archive = path.join(work!, 'release.tar.gz');
      const unpack = path.join(work!, 'unpack');

      await files.mkdir(unpack);
      await run('tar', ['-czf', archive, '-C', work!, 'release'], { env });
      await run('tar', ['-xzf', archive, '-C', unpack], { env });

      const packed = await auditStage(stage, { required: [...payload, 'bin/bundle.json'], executables });
      const extracted = await auditStage(path.join(unpack, 'release'), {
        required: [...payload, 'bin/bundle.json'], executables,
      });

      if (JSON.stringify(packed) !== JSON.stringify(extracted)) {
        throw new Error('Архив изменил байты или права поставки');
      }

      await files.writeFile(path.join(work!, 'release.tar.gz.sha256'), [
        `${await sha256File(archive)}  release.tar.gz`,
        `${await sha256File(path.join(stage, 'bin/bundle.json'))}  release/bin/bundle.json`,
        '',
      ].join('\n'), { mode: 0o644 });

      if (options.sign) {
        const checksum = await files.readFile(path.join(work!, 'release.tar.gz.sha256'), 'utf8');
        const signature = await options.sign(checksum);
        const lines = checksum.split('\n');
        const archiveLine = lines.find((line) => {
          return line.includes('release.tar.gz');
        });
        const bundleLine = lines.find((line) => {
          return line.includes('bundle.json');
        });

        if (!bundleLine || !archiveLine) {
          throw new Error('Файл сумм не содержит ожидаемых строк');
        }

        const archiveStat = await files.stat(archive);

        await files.writeFile(path.join(work!, 'release.tar.gz.sha256.sig'),
          `${signature}\n`, { mode: 0o644 });
        await files.writeFile(path.join(work!, 'channel.json'), `${JSON.stringify({
          format: 1,
          latest: {
            version,
            commit: source.commit,
            archiveSha256: archiveLine.split(' ')[0],
            archiveSize: archiveStat.size,
            bundleSha256: bundleLine.split(' ')[0],
            signature,
            archiveUrl: null,
            compat: {
              os: 'linux',
              arch: 'x64',
              glibc: '2.28'
            },
          },
          publishedAt: new Date().toISOString(),
        }, null, 2)}\n`, { mode: 0o644 });
      }
    });
    await step('bundle.publish', () => {
      return publish(root, work!, files,
      options.sign ? ['release.tar.gz.sha256.sig', 'channel.json'] : []);
    });
  } catch (error) {
    preserve = Boolean((error as { preserveWork?: boolean }).preserveWork);

    throw error;
  } finally {
    if (work && !preserve) {
      await files.rm(work, { recursive: true, force: true });
    }

    await lock.release();
  }
}
