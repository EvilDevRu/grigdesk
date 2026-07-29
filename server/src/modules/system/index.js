// Модуль system — нагрузка домашнего ПК (CPU/RAM) + жизненный цикл самого сервера
// (режим запуска и перезапуск кнопкой из «Настройки → Сервер»).
import fp from 'fastify-plugin';
import { spawn } from 'node:child_process';
import path from 'node:path';

async function systemModule(fastify, opts) {
  const { system, config } = opts;
  fastify.get('/api/system', async () => system.read());

  // Под systemd у процесса сервиса есть INVOCATION_ID — по нему выбирается способ перезапуска.
  const underSystemd = () => !!process.env.INVOCATION_ID;

  // Режим запуска — для блока «Сервер» в настройках.
  fastify.get('/api/system/server', async () => ({
    systemd: underSystemd(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  }));

  // Перезапуск сервера. Ответ уходит ДО смерти процесса (задержка), иначе кнопка не
  // узнает, что нажалась. Под systemd — просто выход: юнит с Restart=always поднимет
  // чистую копию и подтянет новый код после деплоя. При ручном запуске поднимать некому,
  // поэтому bin/restart отвязанным процессом (переживает смерть родителя: detached здесь
  // + setsid внутри самого скрипта). РЕЖИМЫ НЕ СМЕШИВАЕМ: bin/restart под systemd поднял
  // бы второй экземпляр против юнита — ровно так юнит намотал 7553 падения 27.07.2026
  // (см. комментарий в deploy/cockpit-server.service).
  fastify.post('/api/system/restart', async () => {
    const systemd = underSystemd();
    setTimeout(() => {
      if (systemd) { process.exit(0); return; }
      const child = spawn('bash', [path.join(config.rootDir, 'bin', 'restart')], {
        detached: true, stdio: 'ignore', cwd: config.rootDir,
      });
      child.unref();
    }, 400);
    return { ok: true, mode: systemd ? 'systemd' : 'script' };
  });
}

export default fp(systemModule, { name: 'module-system' });
