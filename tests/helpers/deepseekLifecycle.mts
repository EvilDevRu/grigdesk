import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { deepSeekTestArtifactsRoot, ensureTestDeepSeekBinary } from './deepseekBinary.mts';

export interface DeepSeekLifecycleFixture {
  binary: string;
  directory: string;
  cache: string;
  plugin: string;
  packageId: string;
}

export interface DeepSeekLifecycleCase {
  launcher: ChildProcess;
  workerPid: number;
  shellPid: number | null;
  directory: string;
  marker: string;
  containment: 'scope' | 'fallback group' | 'boot only';
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): { stdout: string; stderr: string };
}

const pluginSource = String.raw`
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const name = 'grigdesk-bootstrap-stop-probe';
export const inject = ['subprocess'];

// Настоящий Loader доходит до тестового module barrier; IPC disconnect уже установлен.
// Барьер не меняет bootstrap или production entry и не запускает управляемую команду.
if (process.env.GRIGDESK_TEST_BOOT_GATE) {
  writeFileSync(process.env.GRIGDESK_TEST_BOOT_GATE + '.ready', String(process.pid));
  await new Promise(() => {});
}

/**
 * Shell принадлежит настоящему upstream subprocess service и пишет только в каталог теста.
 * Режим зависшего disposal — явная инъекция отказа, а не другая реализация процесса.
 */
export function apply(ctx) {
  const directory = process.env.GRIGDESK_TEST_STOP_DIR;

  writeFileSync(path.join(directory, 'worker.pid'), String(process.pid));
  writeFileSync(path.join(directory, 'facts.json'), JSON.stringify({
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    execPath: process.execPath,
    value: process.env.GRIGDESK_TEST_VALUE,
    hang: process.env.GRIGDESK_TEST_HANG_DISPOSAL ?? null,
  }));
  process.stderr.write('grigdesk-lifecycle-stderr\n');

  if (process.env.GRIGDESK_TEST_WORKER_EXIT) {
    setTimeout(() => process.exit(Number(process.env.GRIGDESK_TEST_WORKER_EXIT)), 300);
    return;
  }

  const handle = ctx.subprocess.spawn({
    argv: ['/bin/sh', '-c',
      'printf "%s\n" "$$" > "$1/shell.pid"; while :; do printf x >> "$1/marker"; /usr/bin/sleep 0.05; done',
      'stop-probe', directory],
    cwd: directory,
    stdio: {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    },
    graceMs: 200,
    env: { PATH: '/usr/bin:/bin' },
  });

  void handle.done.catch(() => {});

  // Читаются факты уже состоявшегося выбора, без повторного native probe и без подмены provider.
  const containment = ctx.subprocess.fallbackWarningIssued === true ? 'fallback group'
    : ctx.subprocess.linuxDeepProbePassed === true ? 'scope' : 'unknown';

  writeFileSync(path.join(directory, 'containment'), containment);

  if (process.env.GRIGDESK_TEST_HANG_DISPOSAL === '1') {
    ctx.effect(() => () => {
      writeFileSync(path.join(directory, 'disposal-start'), 'started');
      return new Promise(() => {});
    }, 'bootstrap-stop-probe: blocked disposal');
  }
}
`;

/**
 * Ограничивает ожидание принадлежащего тесту exit и всегда снимает свой таймер.
 * Истечение бюджета возвращается отдельно от кода завершившегося процесса.
 */
async function exitWithin(run: DeepSeekLifecycleCase, milliseconds: number):
  Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      run.exit,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Сигнал группы допускается только для PID, полученного при собственном detached spawn.
 * Отсутствие группы нормально после завершения, EPERM и другие ошибки не скрываются.
 */
function signalOwnGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error('Неверный PID собственной process group');
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Таблица остановки использует production candidate и его общий прогретый cache.
 * Test plugin наблюдает свои PID и управляемую команду, не меняя entry или bootstrap.
 */
export async function prepareDeepSeekLifecycle(): Promise<DeepSeekLifecycleFixture> {
  const runtime = await ensureTestDeepSeekBinary();
  const directory = path.join(deepSeekTestArtifactsRoot(), 's10a');
  const plugin = path.join(directory, 'managed-shell-plugin.mjs');

  await mkdir(directory, { recursive: true });
  await writeFile(plugin, pluginSource);

  return {
    binary: runtime.binary,
    directory,
    cache: runtime.cacheDir,
    plugin,
    packageId: runtime.info.packageId,
  };
}

/**
 * Каждый запуск получает свой каталог и настоящий управляемый shell через upstream service.
 * PID возвращается только после собственного marker/barrier, а не через поиск чужих процессов.
 */
export async function launchDeepSeekLifecycleCase(
  fixture: DeepSeekLifecycleFixture,
  label: string,
): Promise<DeepSeekLifecycleCase> {
  await mkdir(path.join(fixture.directory, 'cases'), { recursive: true });

  const directory = await mkdtemp(path.join(fixture.directory, 'cases', `${label}-`));
  const overlay = path.join(directory, 'overlay.yml');
  const home = path.join(directory, 'home');
  const barrier = path.join(directory, 'boot-gate');

  await mkdir(home);
  await writeFile(overlay, '- insert:\n    - id: bootstrap-stop-marker\n      name: '
    + `${JSON.stringify(pathToFileURL(fixture.plugin).href)}\n`);

  const launcher = spawn(fixture.binary, ['--cache-dir', fixture.cache,
    '--expect-package-id', fixture.packageId,
    '--profile', 'acp', '--patch', overlay], {
    cwd: directory,
    detached: true,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      DSH_HOME: home,
      TMPDIR: directory,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
      GRIGDESK_TEST_STOP_DIR: directory,
      GRIGDESK_TEST_HANG_DISPOSAL: label === 'disposal-timeout' ? '1' : undefined,
      GRIGDESK_TEST_BOOT_GATE: label === 'boot-kill' ? barrier : undefined,
      GRIGDESK_TEST_WORKER_EXIT: label === 'worker-exit' ? '37' : undefined,
      GRIGDESK_TEST_VALUE: 'значение с пробелами',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    launcher.once('error', reject);
    launcher.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let stdout = '';
  let stderr = '';
  const run: DeepSeekLifecycleCase = {
    launcher,
    workerPid: 0,
    shellPid: null,
    directory,
    marker: path.join(directory, 'marker'),
    containment: 'boot only',
    exit,
    output: () => ({ stdout, stderr }),
  };

  launcher.stdout!.on('data', (chunk) => {
    stdout = `${stdout}${String(chunk)}`.slice(-2_097_152);
  });
  launcher.stderr!.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-2_097_152);
  });


  try {
    /**
     * Готовность подтверждают известный worker, PID shell и реальная запись marker.
     * Boot-сценарий вместо запуска Harness ждёт собственный барьер перед импортом.
     */
    const ready = async () => {
      const deadline = performance.now() + 30000;

      while (performance.now() < deadline) {
        if (launcher.exitCode !== null || launcher.signalCode !== null) {
          throw new Error(`Launcher вышел до marker: ${launcher.exitCode}; ${stderr}`);
        }

        const pidFile = label === 'boot-kill' ? `${barrier}.ready` : path.join(directory, 'worker.pid');
        const observed = Number(await readFile(pidFile, 'utf8').catch(() => ''));
        const shell = Number(await readFile(path.join(directory, 'shell.pid'), 'utf8').catch(() => ''));
        const marker = await readFile(run.marker, 'utf8').catch(() => '');
        const containment = await readFile(path.join(directory, 'containment'), 'utf8').catch(() => '');

        if (Number.isSafeInteger(observed) && observed > 1
          && (['boot-kill', 'worker-exit'].includes(label)
            || shell > 1 && marker.length > 0 && containment)) {
          run.workerPid = observed;
          run.shellPid = shell > 1 ? shell : null;

          if (!['boot-kill', 'worker-exit'].includes(label)) {
            if (containment !== 'scope' && containment !== 'fallback group') {
              throw new Error('Upstream не сообщил наблюдаемый режим containment');
            }

            run.containment = containment;
          }

          return;
        }

        await pause(25);
      }

      throw new Error(`Managed shell не записал marker за 30 с; ${stderr}`);
    };

    await Promise.race([
      ready(),
      exit.then((outcome) => {
        throw new Error(`Launcher вышел до готовности: ${outcome.code}; ${stderr}`);
      }),
    ]);

    return run;
  } catch (error) {
    const shell = Number(await readFile(path.join(directory, 'shell.pid'), 'utf8').catch(() => ''));

    run.shellPid = shell > 1 ? shell : null;
    await cleanupDeepSeekLifecycleCase(fixture, run, label);

    throw error;
  }
}

/**
 * Проверка отличает отсутствие процесса от отказа доступа к нему.
 * Неизвестная ошибка не считается завершением и остаётся видимой тесту.
 */
export async function deepSeekLifecyclePidAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }

    throw error;
  }
}

/**
 * Остановка ограничена бюджетами 6+2 с и завершает только принадлежащую запуску группу.
 * Эскалация и ненулевой cleanup outcome дают отказ, а не преждевременный успех.
 */
export async function stopDeepSeekLifecycleCase(run: DeepSeekLifecycleCase): Promise<void> {
  run.launcher.kill('SIGTERM');

  const outcome = await exitWithin(run, 6000);

  if (!outcome) {
    signalOwnGroup(run.launcher.pid!, 'SIGKILL');
    await exitWithin(run, 2000);

    throw new Error('cleanup: graceful завершение превысило бюджет; группа эскалирована');
  }

  if (outcome.code !== 0 && outcome.code !== 130) {
    throw new Error(`cleanup: worker завершился без подтверждённого disposal (${outcome.code})`);
  }
}

/**
 * Cleanup теста сохраняет наблюдения до удаления файлов и завершает только свои PID.
 * Он не меняет уже записанный исход проверяемого stop.
 */
export async function cleanupDeepSeekLifecycleCase(
  fixture: DeepSeekLifecycleFixture,
  run: DeepSeekLifecycleCase,
  label: string,
): Promise<void> {
  const output = run.output();

  await writeFile(path.join(fixture.directory, `${label}.stdout.log`), output.stdout);
  await writeFile(path.join(fixture.directory, `${label}.stderr.log`), output.stderr);
  signalOwnGroup(run.launcher.pid!, 'SIGKILL');

  if (run.shellPid && await deepSeekLifecyclePidAlive(run.shellPid)) {
    const status = await readFile(`/proc/${run.shellPid}/stat`, 'utf8');
    const fields = status.slice(status.lastIndexOf(')') + 2).split(' ');

    if (Number(fields[2]) === run.shellPid) {
      signalOwnGroup(run.shellPid, 'SIGKILL');
    } else {
      process.kill(run.shellPid, 'SIGKILL');
    }
  }

  await exitWithin(run, 2000);
  await rm(run.directory, { recursive: true, force: true });
}
