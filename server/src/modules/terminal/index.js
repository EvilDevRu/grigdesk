// Модуль «Терминал» — веб-терминал на «мозге» через WebSocket.
// Нужен, чтобы авторизовать Claude (`claude login`) и чинить что-то руками, не отходя от кокпита.
//
// PTY выделяем системным `script` (util-linux) — БЕЗ нативных зависимостей (node-pty требует
// компилятор C++ и ломал бы npm install у тех, у кого нет build-essential). `script -qfc CMD
// /dev/null` запускает CMD внутри псевдотерминала и прокидывает ввод/вывод в свои stdio.
import fp from 'fastify-plugin';
import { spawn } from 'node:child_process';
import os from 'node:os';

const MAX_SESSIONS = 6; // разумный потолок параллельных терминалов
let active = 0;

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

async function terminalModule(fastify) {
  fastify.get('/api/terminal', { websocket: true }, (socket, req) => {
    // Доступ проверен глобальным гардом (plugins/auth.js): хуки Fastify выполняются и для
    // WS-роутов, поэтому без валидной сессии сюда не доходят. Прежний `?token=` убран —
    // секрет в query-параметре оседает в логах, cookie этого не делает.
    if (active >= MAX_SESSIONS) { socket.close(1013, 'too many sessions'); return; }

    const cols = clampInt(req.query.cols, 100, 20, 500);
    const rows = clampInt(req.query.rows, 30, 5, 200);
    const shell = process.env.SHELL || '/bin/bash';
    const home = os.homedir();
    // Начальный размер PTY задаём через stty один раз, затем — логин-шелл.
    const rc = `stty rows ${rows} cols ${cols} 2>/dev/null; cd ${home}; exec ${shell} -l`;

    const child = spawn('script', ['-qfc', rc, '/dev/null'], {
      cwd: home,
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
    });
    active++;
    fastify.log.info({ pid: child.pid, cols, rows }, 'terminal: PTY запущен');

    // PTY → клиент (сырые байты, включая управляющие последовательности).
    const toClient = (d) => { if (socket.readyState === 1) socket.send(d); };
    child.stdout.on('data', toClient);
    child.stderr.on('data', toClient);

    // Клиент → PTY. Протокол — JSON-конверт: {t:'in',d} ввод. (Ресайз на лету `script`
    // не поддерживает — начальный размер уже задан; клиент только перерисовывает xterm.)
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'in' && typeof msg.d === 'string' && child.stdin.writable) child.stdin.write(msg.d);
    });

    const kill = () => { try { child.kill('SIGHUP'); } catch { /* уже мёртв */ } };
    child.on('exit', (code) => {
      active = Math.max(0, active - 1);
      fastify.log.info({ pid: child.pid, code }, 'terminal: PTY завершён');
      try { socket.close(); } catch { /* уже закрыт */ }
    });
    socket.on('close', kill);
    socket.on('error', kill);
  });
}

export default fp(terminalModule, { name: 'module-terminal' });
