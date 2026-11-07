// Supervisor находится вне группы пакета и выпускает gated leader только после ACK.
// IPC передаёт контекст запуска; argv самого helper не содержит адресов или секретов.
import { fork, spawn } from 'node:child_process';
import { liveGroupMembers, readProcessIdentity } from './workerIdentity.ts';
import { workspaceWithinBudget } from './workspaceBudget.ts';

/**
 * IPC может закрыться одновременно с остановкой группы.
 * Отсутствие получателя не превращает cleanup собственного процесса в исключение.
 */
function send(message) {
  if (process.connected) {
    process.send(message, () => {});
  }
}

/**
 * Leader ничего из пакета не запускает до команды run после durable ACK.
 * Целевой executable наследует его PGID и не получает shell-посредника.
 */
async function leader() {
  const own = await readProcessIdentity(process.pid);

  process.channel?.ref();
  process.on('message', (message) => {
    if (message.type !== 'run') {
      return;
    }

    const target = spawn(message.file, message.args, {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let failed = false;

    target.once('error', () => {
      failed = true;
      process.stderr.write('Не удалось запустить команду.');
    });
    target.once('exit', (code, signal) => {
      send({
        type: 'targetExit',
        code: code ?? 1,
        signal,
      });
    });
    target.once('close', () => {
      if (failed) {
        send({
          type: 'targetExit',
          code: 127,
          signal: null,
        });
      }
    });
  });
  send({
    type: 'leader',
    pid: process.pid,
    pgid: own.pgid,
    startTime: own.startTime,
  });
}

/**
 * Server получает identity группы до допуска команды к файловым эффектам.
 * Прерывание IPC закрывает только собственную группу, сам supervisor остаётся вне неё.
 */
function supervise() {
  let child = null;
  let result = { code: 1, signal: null };
  let stopped = false;
  let killTimer = null;
  let monitorTimer = null;
  let measurement = Promise.resolve();
  let budget = null;
  let workspaceLimitExceeded = false;
  let monitoring = true;

  /**
   * TERM прекращает допуск, а независимый timer гарантирует KILL всей группы.
   * Повторный abort не отодвигает эскалацию и не завершает supervisor раньше детей.
   */
  const stop = () => {
    if (stopped) {
      return;
    }

    stopped = true;

    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Группа уже могла завершиться от TERM.
            // Таймер никогда не переключается на чужой процесс.
          }
        }, 2000);
      } catch {
        // Своя группа могла завершиться между сообщением и сигналом.
        // Supervisor не использует сохранённый чужой PGID.
      }
    }
  };

  /**
   * Измерение одно и то же для periodic и final проверок.
   * Последний обход входит в outcome и завершается до прекращения supervisor.
   */
  const measure = () => {
    measurement = measurement.then(async () => {
      if (!budget) {
        return;
      }

      try {
        if (!await workspaceWithinBudget(budget)) {
          workspaceLimitExceeded = true;
          stop();
        }
      } catch {
        workspaceLimitExceeded = true;
        stop();
      }
    });

    return measurement;
  };

  /**
   * Следующий timer ставится только после завершения обхода.
   * Остановка команды запрещает новые измерения, но ждёт уже начатое.
   */
  const monitor = async () => {
    await measure();

    if (monitoring && !stopped) {
      monitorTimer = setTimeout(monitor, budget.checkIntervalMs);
    }
  };

  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
  process.on('message', async (message) => {
    if (message.type === 'start') {
      budget = message.workspaceBudget ?? null;
      child = fork(new URL(import.meta.url), ['--leader'], {
        detached: true,
        env: { PATH: '/usr/bin:/bin' },
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      child.on('message', async (event) => {
        if (event.type === 'leader') {
          const own = await readProcessIdentity(process.pid);

          await measure();

          send({
            type: 'worker',
            worker: {
              commandId: message.commandId,
              supervisorPid: process.pid,
              supervisorStartTime: own.startTime,
              pid: event.pid,
              pgid: event.pgid,
              startTime: event.startTime,
            },
          });
        } else if (event.type === 'targetExit') {
          result = { code: event.code, signal: event.signal };
          stop();
        }
      });
      child.once('close', async () => {
        monitoring = false;
        clearTimeout(monitorTimer);

        while ((await liveGroupMembers(child.pid)).length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        clearTimeout(killTimer);
        await measure();
        send({
          type: 'result',
          ...result,
          code: workspaceLimitExceeded ? 1 : result.code,
          workspaceLimitExceeded,
        });

        if (process.connected) {
          process.disconnect();
        }
      });

      if (budget) {
        void monitor();
      }
    } else if (message.type === 'ack' && !stopped && child?.connected) {
      child.send({ type: 'run', ...message.command }, () => {});
    } else if (message.type === 'stop') {
      stop();
    }
  });
}

if (process.argv.includes('--leader')) {
  await leader();
} else {
  supervise();
}
