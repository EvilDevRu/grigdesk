import { spawn } from 'node:child_process';
import { once } from 'node:events';

const mode = process.argv[2];

if (mode === 'critic') {
  setInterval(() => {}, 1000);
} else {
  const critic = spawn(process.execPath, [import.meta.filename, 'critic'], { stdio: 'ignore' });

  await once(critic, 'spawn');
  setInterval(() => {}, 1000);
  process.stdout.write(`${JSON.stringify({ critic: critic.pid })}\n`);

  process.once('SIGTERM', async () => {
    if (mode === 'escalation') {
      return;
    }

    const closed = once(critic, 'close');

    critic.kill('SIGTERM');
    await closed;

    if (mode === 'signal') {
      process.kill(process.pid, 'SIGKILL');

      return;
    }

    if (mode === '75') {
      // Критик уже остановлен; блокируется отдельный синтетический disposer.
      // Таймер моделирует production timeout, не причину живого зависания.
      setTimeout(() => process.exit(75), 25);
      await new Promise(() => {});
    }

    process.exit(Number(mode));
  });
}
