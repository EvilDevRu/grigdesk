import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertReleaseNodeRuntime,
  mutatePersistentState,
  parseRemoteTags,
  readPersistentState,
} from '../lib/cockpitRelease.ts';

const MAX_BUFFER = 4 * 1024 * 1024;
const PUBLISH_CONTRACT = '1';
const PUBLISH_PENDING = 'server/runtime/deepseek/publish-pending.json';
const UNUSABLE_PREVIOUS_RUNTIME = ['deepseek_runtime_corrupt', 'deepseek_runtime_incompatible'];

/**
 * Installed worker узнаёт наличие runtime по явному target contract, сохраняя старые релизы.
 * Неизвестный контракт отказывает до checkout и не превращается в пропуск подготовки.
 */
async function runtimeContract(source) {
  let value;

  try {
    value = JSON.parse(await readFile(path.join(source, 'server/deepseek-runtime-contract.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  if (value.format !== 1 || value.publishContract !== Number(PUBLISH_CONTRACT)
      || !['installed', 'embedded'].includes(value.mode)) {
    throw new Error('unsupported_runtime_publish_contract');
  }

  return value;
}

/**
 * Worker переносит generation собственным проверенным publisher, без imports из staging.
 * Загружается один раз до fast-forward: после него этот путь указывает уже на код
 * целевого релиза, который смешался бы с загруженным installed runtimeArtifact.
 */
async function runtimePublisher() {
  return import('../../../tools/deepseekRuntimePublication.ts');
}

/**
 * Целевой prepare сообщает о повторном использовании последней строкой JSON.
 * Старый или незнакомый вывод означает обычную сборку в checkout релиза.
 */
function reusedRuntimeBuildId(stdout) {
  const line = String(stdout || '').trim().split('\n').at(-1) || '';

  try {
    const value = JSON.parse(line);

    return value?.reused === true && /^[a-f0-9]{64}$/u.test(value.buildId || '') ? value.buildId : null;
  } catch {
    return null;
  }
}

/**
 * Маркер незавершённой публикации читается без исключений: null — маркера нет,
 * jobId null — файл нечитаем или не нашего формата, и вызывающий обязан отказать.
 */
async function readPublishPending(rootDir) {
  let text;

  try {
    text = await readFile(path.join(rootDir, PUBLISH_PENDING), 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? null : { jobId: null };
  }

  try {
    const value = JSON.parse(text);
    const valid = typeof value?.jobId === 'string' && /^[0-9a-f-]{36}$/i.test(value.jobId);

    return { jobId: valid ? value.jobId : null };
  } catch {
    return { jobId: null };
  }
}

/**
 * Чужой pending — незавершённая публикация другого job: сборка поверх неё перезаписала бы
 * маркер и спрятала нужное восстановление. Отказ называет точную команду восстановления.
 */
async function assertNoForeignPending(rootDir, jobId) {
  const pending = await readPublishPending(rootDir);

  if (!pending || pending.jobId === jobId) {
    return;
  }

  const error = new Error(pending.jobId
    ? `Публикация runtime DeepSeek предыдущего обновления (job ${pending.jobId}) не завершена. `
      + 'Из корня Cockpit выполните: node server/scripts/prepareDeepSeekRuntime.mts '
      + `--recover-job ${pending.jobId} — и затем перезапустите Cockpit.`
    : `Маркер незавершённой публикации runtime DeepSeek (${PUBLISH_PENDING}) не читается, `
      + 'поэтому --recover-job неприменим. Сверьте checkout и runtime вручную по журналу '
      + 'обновлений и только после этого уберите маркер.');

  error.safeCode = 'runtime_publication_pending';

  throw error;
}

/**
 * Pending появляется целиком через rename приватного временного файла: оборванная запись
 * не оставляет нечитаемый маркер, который заблокировал бы все следующие обновления.
 */
async function writePublishPending(rootDir, marker) {
  const file = path.join(rootDir, PUBLISH_PENDING);
  const temporary = path.join(path.dirname(file), `.publish-pending-${marker.jobId}.tmp`);

  await mkdir(path.dirname(file), { recursive: true });

  try {
    await writeFile(temporary, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});

    throw error;
  }
}

/**
 * При сбое снимается только собственный маркер. Чужой или нечитаемый pending принадлежит
 * другой незавершённой публикации и нужен её восстановлению.
 */
async function removeOwnPending(rootDir, jobId) {
  const pending = await readPublishPending(rootDir);

  if (pending?.jobId === jobId) {
    await rm(path.join(rootDir, PUBLISH_PENDING), { force: true });
  }
}

function argsFromCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new Error('invalid_worker_arguments');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function run(file, args, { cwd, env = process.env, timeout = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (error, stdout = '', stderr = '') => resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        timedOut: !!error?.killed,
        stdout: String(stdout), stderr: String(stderr),
      }));
  });
}

async function command(file, args, options, errorCode, errorMessage) {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    const error = new Error(errorMessage);
    error.safeCode = result.timedOut ? `${errorCode}_timeout` : errorCode;
    throw error;
  }
  return result;
}

async function git(root, args, errorCode = 'git_failed', message = 'Git-проверка завершилась ошибкой.') {
  return command('git', ['-C', root, ...args], {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 2 * 60_000,
  }, errorCode, message);
}

async function setJob(statePath, jobId, patch) {
  return mutatePersistentState(statePath, (state) => {
    if (state.job?.id !== jobId) throw new Error('job_replaced');
    return {
      ...state,
      job: { ...state.job, ...patch, updatedAt: new Date().toISOString() },
    };
  });
}

async function stage(statePath, jobId, name) {
  await setJob(statePath, jobId, { status: name, stage: name });
}

async function ensureCheckout(root, job, { requireMain }) {
  const [head, branch, dirty] = await Promise.all([
    git(root, ['rev-parse', 'HEAD'], 'checkout_unreadable', 'Не удалось прочитать текущий SHA.'),
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'branch_unreadable', 'Не удалось прочитать текущую ветку.'),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'status_unreadable', 'Не удалось проверить рабочее дерево.'),
  ]);
  if (head.stdout.trim().toLowerCase() !== job.expectedCheckoutSha) {
    const error = new Error('Checkout изменился после подтверждения.');
    error.safeCode = 'checkout_changed';
    throw error;
  }
  if (dirty.stdout.length) {
    const error = new Error('Рабочее дерево стало dirty; обновление остановлено до сборки.');
    error.safeCode = 'working_tree_dirty';
    throw error;
  }
  if (requireMain && branch.stdout.trim() !== 'main') {
    const error = new Error('Установка релиза разрешена только в ветке main.');
    error.safeCode = 'branch_not_main';
    throw error;
  }
}

async function ensureFreeSpace(root) {
  const info = await statfs(root);
  const available = Number(info.bavail) * Number(info.bsize);
  if (available < 1024 ** 3) {
    const error = new Error('Для безопасной временной сборки нужен как минимум 1 ГБ свободного места.');
    error.safeCode = 'insufficient_disk_space';
    throw error;
  }
}

async function resolveRemoteTag(root, tag) {
  const remote = await git(root, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    'remote_unavailable', 'Не удалось повторно проверить целевой тег.');
  return parseRemoteTags(remote.stdout).find((item) => item.tag === tag) || null;
}

async function prepareRelease(root, job) {
  const remote = await resolveRemoteTag(root, job.targetTag);
  if (!remote || remote.sha !== job.targetSha) {
    const error = new Error('Опубликованный тег изменился после проверки; установка остановлена.');
    error.safeCode = 'remote_tag_changed';
    throw error;
  }
  const local = await run('git', ['-C', root, 'show-ref', '--verify', '--hash', `refs/tags/${job.targetTag}`], {
    cwd: root, timeout: 10_000,
  });
  const hasLocalTag = local.code === 0;
  if (hasLocalTag) {
    const type = await git(root, ['cat-file', '-t', `refs/tags/${job.targetTag}`],
      'local_tag_unreadable', 'Не удалось проверить тип локального тега.');
    if (type.stdout.trim() !== 'tag') {
      const error = new Error('Локальный stable-тег должен быть аннотированным.');
      error.safeCode = 'local_tag_not_annotated';
      throw error;
    }
    const commit = await git(root, ['rev-list', '-n', '1', job.targetTag], 'local_tag_unreadable', 'Не удалось проверить локальный тег.');
    if (commit.stdout.trim().toLowerCase() !== job.targetSha) {
      const error = new Error('Локальный тег указывает на другой commit.');
      error.safeCode = 'local_tag_mismatch';
      throw error;
    }
  } else {
    // Получаем объект через FETCH_HEAD, но пока не создаём локальный тег. Если ancestry,
    // npm или build упадут, refs рабочего репозитория останутся неизменными.
    await git(root, ['fetch', '--no-tags', 'origin', `refs/tags/${job.targetTag}`],
      'tag_fetch_failed', 'Не удалось получить целевой тег.');
  }
  const fetched = await git(root, ['rev-list', '-n', '1', hasLocalTag ? job.targetTag : 'FETCH_HEAD'],
    'target_unreadable', 'Не удалось разрешить целевой тег.');
  if (fetched.stdout.trim().toLowerCase() !== job.targetSha) {
    const error = new Error('Полученный тег не совпадает с проверенным commit.');
    error.safeCode = 'target_sha_mismatch';
    throw error;
  }
  const ancestor = await run('git', ['-C', root, 'merge-base', '--is-ancestor', job.expectedCheckoutSha, job.targetSha], {
    cwd: root, timeout: 30_000,
  });
  if (ancestor.code !== 0) {
    const error = new Error('Релиз нельзя применить fast-forward из текущего checkout.');
    error.safeCode = ancestor.code === 1 ? 'checkout_diverged' : 'ancestry_check_failed';
    throw error;
  }
  return { needsTagPublish: !hasLocalTag };
}

async function publishReleaseTag(root, job, preparation) {
  if (!preparation?.needsTagPublish) return;
  await git(root, ['fetch', '--no-tags', 'origin', `refs/tags/${job.targetTag}:refs/tags/${job.targetTag}`],
    'tag_publish_failed', 'Не удалось опубликовать проверенный тег локально.');
  const commit = await git(root, ['rev-list', '-n', '1', job.targetTag],
    'target_unreadable', 'Не удалось проверить опубликованный локальный тег.');
  if (commit.stdout.trim().toLowerCase() !== job.targetSha) {
    const error = new Error('Локальный тег после получения не совпал с проверенным commit.');
    error.safeCode = 'target_sha_mismatch';
    throw error;
  }
}

async function archiveSource(root, sha, workDir) {
  const archive = path.join(workDir, 'source.tar');
  const source = path.join(workDir, 'source');
  await mkdir(source, { recursive: true });
  await git(root, ['archive', '--format=tar', `--output=${archive}`, sha], 'archive_failed', 'Не удалось подготовить снимок исходников.');
  await command('tar', ['-xf', archive, '-C', source], { cwd: workDir, timeout: 2 * 60_000 },
    'archive_extract_failed', 'Не удалось распаковать снимок исходников.');
  return source;
}

async function replaceDir(source, destination, backup) {
  let movedOld = false;
  try {
    await rename(destination, backup);
    movedOld = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(source, destination);
  } catch (error) {
    if (movedOld) await rename(backup, destination).catch(() => {});
    throw error;
  }
  return movedOld;
}

/**
 * Web, dependencies и runtime публикуются при установленном launch blocker.
 * При сбое восстанавливаются каталоги и указатель до восстановления checkout.
 * Publisher передаётся уже загруженным из установленного дерева, до fast-forward.
 */
async function publishBuild(root, source, job, runtime, publisher, progress) {
  const webDestination = path.join(root, 'web', 'dist');
  const serverDestination = path.join(root, 'server', 'node_modules');
  const webBackup = `${webDestination}.cockpit-backup-${job.id}`;
  const serverBackup = `${serverDestination}.cockpit-backup-${job.id}`;
  let webMoved = false;
  let serverMoved = false;
  let webPublished = false;
  let serverPublished = false;

  try {
    await progress('publishing-web');
    webMoved = await replaceDir(path.join(source, 'web', 'dist'), webDestination, webBackup);
    webPublished = true;
    await progress('publishing-server');
    serverMoved = await replaceDir(path.join(source, 'server', 'node_modules'), serverDestination, serverBackup);
    serverPublished = true;

    if (runtime) {
      await progress('publishing-runtime');

      const published = await publisher.publishDeepSeekGeneration(
        path.join(source, 'server/runtime/deepseek/current'), path.join(root, 'server/runtime/deepseek'));

      if (published.buildId !== runtime.buildId) {
        throw new Error('runtime_changed_during_publication');
      }
    }
  } catch (error) {
    try {
      if (serverPublished) {
        await rm(serverDestination, { recursive: true, force: true });

        if (serverMoved) {
          await rename(serverBackup, serverDestination);
        }
      }
      if (webPublished) {
        await rm(webDestination, { recursive: true, force: true });

        if (webMoved) {
          await rename(webBackup, webDestination);
        }
      }
      if (runtime) {
        const runtimeRoot = path.join(root, 'server/runtime/deepseek');

        if (job.previousRuntimeBuildId) {
          await publisher.activateDeepSeekGeneration(runtimeRoot, job.previousRuntimeBuildId);
        } else {
          await rm(path.join(runtimeRoot, 'current'), { force: true });
        }
      }
    } catch (rollbackError) {
      rollbackError.safeCode = 'publish_recovery_failed';
      rollbackError.message = 'Частичная публикация требует восстановления; запуск DeepSeek заблокирован.';

      throw rollbackError;
    }

    // Занятый lock публикации — единственная причина, которую оператор устраняет сам,
    // поэтому её безопасный текст с pid владельца сохраняется в сообщении job.
    const lockReason = error.code === 'deepseek_runtime_publish_locked' ? ` ${error.message}.` : '';

    error.safeCode = 'publish_failed';
    error.message = `Не удалось атомарно опубликовать подготовленную сборку.${lockReason}`;

    throw error;
  }
  return {
    web: webMoved ? path.relative(root, webBackup) : null,
    server: serverMoved ? path.relative(root, serverBackup) : null,
  };
}

/**
 * Просит приложение перезапустить опубликованный сервер через защищённый локальный API.
 * Уже остановившийся сервер оставляет задание для подтверждения при следующем запуске.
 */
async function restartDesktop({ origin, tokenFile, jobId }) {
  try {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const response = await fetch(`${origin}/api/system/update-restart`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cockpit-token': token,
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(15_000),
    });

    await response.body?.cancel();

    if (response.status !== 202) {
      throw new Error('restart_rejected');
    }
  } catch (cause) {
    if (cause.code === 'ECONNREFUSED' || cause.cause?.code === 'ECONNREFUSED') {
      return;
    }

    const error = new Error('Не удалось запросить перезапуск сервера после обновления.');

    error.safeCode = 'restart_failed';

    throw error;
  }
}

/**
 * Передаёт перезапуск текущему владельцу сервера после публикации сборки.
 * Приложение использует API, прежние режимы сохраняют свои системные команды.
 */
async function restart(root, mode, desktopOptions) {
  if (mode === 'desktop') {
    await restartDesktop(desktopOptions);

    return;
  }

  if (mode === 'systemd') {
    await command('systemctl', ['--user', 'restart', 'cockpit-server.service'], { cwd: root, timeout: 60_000 },
      'restart_failed', 'systemd не смог перезапустить Cockpit.');
    return;
  }

  await command('bash', [path.join(root, 'deploy', 'restart.sh')], { cwd: root, timeout: 60_000 },
    'restart_failed', 'Скрипт не смог перезапустить Cockpit.');
}

/**
 * Проверяет аргументы и выполняет обновление под собственным межпроцессным замком.
 * После публикации ошибка перезапуска записывается без отката установленного релиза.
 */
async function main() {
  const options = argsFromCli(process.argv.slice(2));
  const { root: rootDir, state: statePath, job: jobId, mode } = options;

  if (!path.isAbsolute(rootDir || '') || !path.isAbsolute(statePath || '')
      || !/^[0-9a-f-]{36}$/i.test(jobId || '') || !['systemd', 'script', 'desktop'].includes(mode)) {
    throw new Error('invalid_worker_arguments');
  }

  if (mode === 'desktop') {
    const origin = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(options.origin || '');

    if (!origin || Number(origin[1]) > 65535 || !path.isAbsolute(options['token-file'] || '')) {
      throw new Error('invalid_worker_arguments');
    }
  }

  const workRoot = options['work-root'] || path.dirname(statePath);

  if (!path.isAbsolute(workRoot)) {
    throw new Error('invalid_worker_arguments');
  }

  const jobLockPath = `${statePath}.job-lock`;
  const logPath = `${statePath}.log`;
  let workDir = null;
  let job = null;
  let releasePreparation = null;
  let runtime = null;
  let publisher = null;
  let checkoutApplied = false;
  let publicationComplete = false;
  try {
    const owner = JSON.parse(await readFile(path.join(jobLockPath, 'owner.json'), 'utf8'));
    if (owner.id !== jobId) throw new Error('job_lock_owner_mismatch');
    job = (await readPersistentState(statePath)).job;
    if (!job || job.id !== jobId || job.status !== 'queued') throw new Error('job_not_queued');
    await setJob(statePath, jobId, { workerPid: process.pid, status: 'preparing', stage: 'preparing' });
    await appendFile(logPath, `${new Date().toISOString()} ${job.id} ${job.kind} started\n`, { mode: 0o600 });

    // Незавершённая публикация прежнего job проверяется до долгой установки и сборки.
    await assertNoForeignPending(rootDir, jobId);

    await mkdir(workRoot, { recursive: true });
    // Публикация — переименование из рабочей папки в дерево кода: другой диск дал бы EXDEV
    // только после долгой сборки, поэтому проверяем заранее.
    if ((await stat(workRoot)).dev !== (await stat(rootDir)).dev) {
      const error = new Error('Рабочая папка обновления должна быть на одном диске с кодом.');

      error.safeCode = 'work_root_other_disk';

      throw error;
    }

    await ensureFreeSpace(workRoot);
    await ensureCheckout(rootDir, job, { requireMain: job.kind === 'update' });
    if (job.kind === 'update') releasePreparation = await prepareRelease(rootDir, job);

    workDir = await mkdtemp(path.join(workRoot, 'cockpit-update-work.'));
    const source = await archiveSource(rootDir, job.targetSha, workDir);

    await assertReleaseNodeRuntime(source);

    const contract = await runtimeContract(source);

    await stage(statePath, jobId, 'installing');
    await command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(source, 'server') },
      'server_dependencies_failed', 'Не удалось установить зависимости сервера.');
    // npm может не создать node_modules у пакета без зависимостей; публикация каталога
    // при этом всё равно должна быть детерминированной.
    await mkdir(path.join(source, 'server', 'node_modules'), { recursive: true });
    // `--include=dev` по той же причине, что и в кнопке пересборки: инструмент сборки
    // web живёт в devDependencies. Через systemd-run worker стартует с чистым env и
    // NODE_ENV не наследует, но fallback-ветка запускает его обычным spawn от сервера —
    // там production передаётся, dev-зависимости не ставятся и сборка падает.
    await command('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: path.join(source, 'web') },
      'web_dependencies_failed', 'Не удалось установить зависимости web.');

    await stage(statePath, jobId, 'building');

    if (contract) {
      // Целевой prepare сам решает, подходит ли установленная сборка: при тех же входах
      // он не собирает заново, а исходники берёт из проверенного кэша установки.
      const prepared = await command(process.execPath, ['scripts/prepareDeepSeekRuntime.mts'], {
        cwd: path.join(source, 'server'),
        env: {
          ...process.env,
          COCKPIT_DEEPSEEK_REUSE_RUNTIME: path.join(rootDir, 'server/runtime/deepseek'),
          COCKPIT_DEEPSEEK_UPSTREAM_SEED: path.join(rootDir, 'third_party/deepseek-harness/upstream'),
        },
      }, 'deepseek_build_failed', 'Не удалось подготовить встроенный runtime DeepSeek.');

      const { readDeepSeekArtifact } = await import('../lib/deepseek/runtimeArtifact.ts');
      const current = path.join(rootDir, 'server/runtime/deepseek/current');
      const reusedBuildId = reusedRuntimeBuildId(prepared.stdout);
      const target = readDeepSeekArtifact(reusedBuildId
        ? current
        : path.join(source, 'server/runtime/deepseek/current')).artifact;

      if (reusedBuildId && target.buildId !== reusedBuildId) {
        const error = new Error('Установленный runtime DeepSeek изменился во время подготовки.');

        error.safeCode = 'deepseek_build_failed';
        throw error;
      }

      // Повторно используемая сборка уже опубликована: публиковать и откатывать нечего,
      // поэтому publisher нужен только новой сборке.
      runtime = reusedBuildId ? null : target;
      publisher = runtime ? await runtimePublisher() : null;

      let previousRuntimeBuildId = null;

      // Повреждённый или несовместимый current не является поколением для отката:
      // обновление продолжается и чинит runtime, а откат снимет такой current.
      try {
        previousRuntimeBuildId = readDeepSeekArtifact(current).artifact.buildId;
      } catch (error) {
        if (UNUSABLE_PREVIOUS_RUNTIME.includes(error.code)) {
          await appendFile(logPath, `${new Date().toISOString()} ${jobId} previous-runtime-unusable `
            + `${error.code}\n`, { mode: 0o600 });
        } else if (error.code !== 'deepseek_runtime_missing') {
          throw error;
        }
      }

      job = {
        ...job,
        previousRuntimeBuildId,
        expectedRuntimeBuildId: target.buildId,
      };
      await setJob(statePath, jobId, {
        previousRuntimeBuildId,
        expectedRuntimeBuildId: target.buildId,
        previousCheckoutSha: job.expectedCheckoutSha,
      });
    }

    await command('npm', ['run', 'build'], {
      cwd: path.join(source, 'web'),
      env: {
        ...process.env,
        VITE_COCKPIT_VERSION: job.targetVersion,
        VITE_COCKPIT_SHA: job.targetSha,
      },
    }, 'web_build_failed', 'Production-сборка web завершилась ошибкой.');

    await stage(statePath, jobId, 'testing');
    await command(process.execPath, ['--test', 'tests/server/cockpit-release.test.js'], {
      cwd: source,
      timeout: 5 * 60_000,
      env: { ...process.env, COCKPIT_RELEASE_PUBLISH_CONTRACT: PUBLISH_CONTRACT },
    },
      'smoke_test_failed', 'Smoke-тест обновления завершился ошибкой.');

    // Повторяем весь меняемый preflight после долгой установки зависимостей и сборки.
    await ensureCheckout(rootDir, job, { requireMain: job.kind === 'update' });

    if (job.kind === 'update') {
      const remote = await resolveRemoteTag(rootDir, job.targetTag);
      if (!remote || remote.sha !== job.targetSha) {
        const error = new Error('Опубликованный тег изменился во время сборки.');
        error.safeCode = 'remote_tag_changed';
        throw error;
      }
      await publishReleaseTag(rootDir, job, releasePreparation);
    }

    await stage(statePath, jobId, 'applying');
    await ensureCheckout(rootDir, job, { requireMain: job.kind === 'update' });
    // Чужой маркер мог появиться за время сборки; свой его не перезаписывает.
    await assertNoForeignPending(rootDir, jobId);

    if (runtime) {
      await writePublishPending(rootDir, {
        jobId,
        workerPid: process.pid,
        previousSha: job.expectedCheckoutSha,
        targetSha: job.targetSha,
        previousBuildId: job.previousRuntimeBuildId,
        expectedBuildId: runtime.buildId,
      });
    }

    await setJob(statePath, jobId, { publicationStage: 'applying-checkout' });

    if (job.kind === 'update') {
      await git(rootDir, ['merge', '--ff-only', job.targetSha], 'fast_forward_failed', 'Git отказался применить релиз fast-forward-ом.');
      checkoutApplied = true;
    }

    const backups = await publishBuild(rootDir, source, job, runtime, publisher,
      (publicationStage) => setJob(statePath, jobId, { publicationStage }));

    publicationComplete = true;

    if (runtime) {
      await rm(path.join(rootDir, PUBLISH_PENDING));
    }

    await setJob(statePath, jobId, { status: 'restarting', stage: 'restarting', backups });
    await restart(rootDir, mode, {
      origin: options.origin,
      tokenFile: options['token-file'],
      jobId,
    });
    await appendFile(logPath, `${new Date().toISOString()} ${jobId} restart-command-completed\n`, { mode: 0o600 });
    // Успех подтверждает только новый server process, увидев свой running SHA.
  } catch (error) {
    if (job) {
      let recovery = null;

      if (checkoutApplied && !publicationComplete) {
        const current = await git(rootDir, ['rev-parse', 'HEAD']).catch(() => null);

        if (current?.stdout.trim() === job.targetSha) {
          const rollback = await run('git', ['-C', rootDir, 'reset', '--keep', job.expectedCheckoutSha],
            { cwd: rootDir, timeout: 30_000 });

          recovery = rollback.code === 0 ? 'previous-checkout-restored' : 'manual-recovery-required';
        } else {
          recovery = 'manual-recovery-required';
        }
      }
      if (runtime && !publicationComplete && recovery !== 'manual-recovery-required') {
        if (error.safeCode === 'publish_recovery_failed') {
          recovery = 'manual-recovery-required';
        } else {
          await removeOwnPending(rootDir, jobId);
        }
      }

      const code = error.safeCode || 'worker_failed';
      const message = error.safeCode ? error.message : 'Worker обновления неожиданно завершился.';

      await setJob(statePath, jobId, {
        status: 'failed',
        stage: 'failed',
        completedAt: new Date().toISOString(),
        error: { code, message },
        recovery,
      }).catch(() => {});
      await appendFile(logPath, `${new Date().toISOString()} ${jobId} failed ${code}\n`, { mode: 0o600 }).catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(jobLockPath, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
