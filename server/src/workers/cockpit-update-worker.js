import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

import {
  mutatePersistentState,
  parseRemoteTags,
  readPersistentState,
} from '../lib/cockpit-release.js';

const MAX_BUFFER = 4 * 1024 * 1024;

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

async function publishBuild(root, source, job) {
  const webDestination = path.join(root, 'web', 'dist');
  const serverDestination = path.join(root, 'server', 'node_modules');
  const webBackup = `${webDestination}.cockpit-backup-${job.id}`;
  const serverBackup = `${serverDestination}.cockpit-backup-${job.id}`;
  let webMoved = false;
  let serverMoved = false;
  try {
    webMoved = await replaceDir(path.join(source, 'web', 'dist'), webDestination, webBackup);
    serverMoved = await replaceDir(path.join(source, 'server', 'node_modules'), serverDestination, serverBackup);
  } catch (error) {
    if (serverMoved) {
      await rm(serverDestination, { recursive: true, force: true }).catch(() => {});
      await rename(serverBackup, serverDestination).catch(() => {});
    }
    if (webMoved) {
      await rm(webDestination, { recursive: true, force: true }).catch(() => {});
      await rename(webBackup, webDestination).catch(() => {});
    }
    error.safeCode = 'publish_failed';
    error.message = 'Не удалось атомарно опубликовать подготовленную сборку.';
    throw error;
  }
  return {
    web: webMoved ? path.relative(root, webBackup) : null,
    server: serverMoved ? path.relative(root, serverBackup) : null,
  };
}

async function restart(root, mode) {
  if (mode === 'systemd') {
    await command('systemctl', ['--user', 'restart', 'cockpit-server.service'], { cwd: root, timeout: 60_000 },
      'restart_failed', 'systemd не смог перезапустить Cockpit.');
    return;
  }
  await command('bash', [path.join(root, 'bin', 'restart')], { cwd: root, timeout: 60_000 },
    'restart_failed', 'Скрипт не смог перезапустить Cockpit.');
}

async function main() {
  const options = argsFromCli(process.argv.slice(2));
  const { root: rootDir, state: statePath, job: jobId, mode } = options;
  if (!path.isAbsolute(rootDir || '') || !path.isAbsolute(statePath || '')
      || !/^[0-9a-f-]{36}$/i.test(jobId || '') || !['systemd', 'script'].includes(mode)) {
    throw new Error('invalid_worker_arguments');
  }
  const jobLockPath = `${statePath}.job-lock`;
  const logPath = `${statePath}.log`;
  let workDir = null;
  let job = null;
  let releasePreparation = null;
  try {
    const owner = JSON.parse(await readFile(path.join(jobLockPath, 'owner.json'), 'utf8'));
    if (owner.id !== jobId) throw new Error('job_lock_owner_mismatch');
    job = (await readPersistentState(statePath)).job;
    if (!job || job.id !== jobId || job.status !== 'queued') throw new Error('job_not_queued');
    await setJob(statePath, jobId, { workerPid: process.pid, status: 'preparing', stage: 'preparing' });
    await appendFile(logPath, `${new Date().toISOString()} ${job.id} ${job.kind} started\n`, { mode: 0o600 });

    await ensureFreeSpace(rootDir);
    await ensureCheckout(rootDir, job, { requireMain: job.kind === 'update' });
    if (job.kind === 'update') releasePreparation = await prepareRelease(rootDir, job);

    workDir = await mkdtemp(path.join(path.dirname(statePath), 'cockpit-update-work.'));
    const source = await archiveSource(rootDir, job.targetSha, workDir);

    await stage(statePath, jobId, 'installing');
    await command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(source, 'server') },
      'server_dependencies_failed', 'Не удалось установить зависимости сервера.');
    // npm может не создать node_modules у пакета без зависимостей; публикация каталога
    // при этом всё равно должна быть детерминированной.
    await mkdir(path.join(source, 'server', 'node_modules'), { recursive: true });
    await command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(source, 'web') },
      'web_dependencies_failed', 'Не удалось установить зависимости web.');

    await stage(statePath, jobId, 'building');
    await command('npm', ['run', 'build'], {
      cwd: path.join(source, 'web'),
      env: {
        ...process.env,
        VITE_COCKPIT_VERSION: job.targetVersion,
        VITE_COCKPIT_SHA: job.targetSha,
      },
    }, 'web_build_failed', 'Production-сборка web завершилась ошибкой.');

    await stage(statePath, jobId, 'testing');
    await command(process.execPath, ['--test', 'tests/server/cockpit-release.test.js'], { cwd: source, timeout: 5 * 60_000 },
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
    if (job.kind === 'update') {
      await git(rootDir, ['merge', '--ff-only', job.targetSha], 'fast_forward_failed', 'Git отказался применить релиз fast-forward-ом.');
    }
    const backups = await publishBuild(rootDir, source, job);
    await setJob(statePath, jobId, { status: 'restarting', stage: 'restarting', backups });
    await restart(rootDir, mode);
    await appendFile(logPath, `${new Date().toISOString()} ${jobId} restart-command-completed\n`, { mode: 0o600 });
    // Успех подтверждает только новый server process, увидев свой running SHA.
  } catch (error) {
    if (job) {
      const code = error.safeCode || 'worker_failed';
      const message = error.safeCode ? error.message : 'Worker обновления неожиданно завершился.';
      await setJob(statePath, jobId, {
        status: 'failed', stage: 'failed', completedAt: new Date().toISOString(),
        error: { code, message },
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
