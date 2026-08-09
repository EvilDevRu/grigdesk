// Модуль «Терминал» — веб-терминал на «мозге» через WebSocket.
// Нужен, чтобы авторизовать Claude (`claude login`) и чинить что-то руками, не отходя от кокпита.
//
// PTY выделяет stdlib Python-helper: stdin/stdout — сырые байты, fd 3 — resize/close.
// Нативных npm-зависимостей нет, но размер меняется у НАСТОЯЩЕГО PTY, а не только у xterm.
import fp from 'fastify-plugin';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const MAX_SESSIONS = 6; // разумный потолок параллельных терминалов
let active = 0;
const HELPER = fileURLToPath(new URL('./pty-helper.py', import.meta.url));

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function spawnPty({ cols, rows, shell, home, python = process.env.COCKPIT_TERMINAL_PYTHON || 'python3' }) {
  return spawn(python, [
    HELPER,
    '--cols', String(cols),
    '--rows', String(rows),
    '--shell', shell,
    '--cwd', home,
    '--control-fd', '3',
  ], {
    cwd: home,
    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
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
    const child = spawnPty({ cols, rows, shell, home });
    active++;
    fastify.log.info({ pid: child.pid, cols, rows }, 'terminal: PTY запущен');

    // PTY → клиент (сырые байты, включая управляющие последовательности).
    const toClient = (d) => { if (socket.readyState === 1) socket.send(d); };
    child.stdout.on('data', toClient);
    child.stderr.on('data', toClient);

    // Клиент → PTY. Ввод и управление идут разными fd, поэтому JSON resize
    // невозможно случайно напечатать в shell.
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'in' && typeof msg.d === 'string' && child.stdin.writable) child.stdin.write(msg.d);
      if (msg.t === 'resize' && child.stdio[3]?.writable) {
        const nextCols = clampInt(msg.cols, cols, 20, 500);
        const nextRows = clampInt(msg.rows, rows, 5, 200);
        child.stdio[3].write(`${JSON.stringify({ t: 'resize', cols: nextCols, rows: nextRows })}\n`);
      }
    });

    let finished = false;
    let killTimer = null;
    const finish = (code, error = null) => {
      if (finished) return;
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      active = Math.max(0, active - 1);
      if (error) fastify.log.warn({ pid: child.pid, err: error.message }, 'terminal: PTY не запустился');
      else fastify.log.info({ pid: child.pid, code }, 'terminal: PTY завершён');
      try { socket.close(error ? 1011 : 1000, error ? 'terminal spawn failed' : ''); } catch { /* уже закрыт */ }
    };
    const stop = () => {
      if (finished) return;
      try { child.stdio[3]?.write(`${JSON.stringify({ t: 'close' })}\n`); } catch { /* helper уже мёртв */ }
      try { child.stdin.end(); } catch { /* ignore */ }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch { /* уже мёртв */ }
        }, 1200);
        killTimer.unref?.();
      }
    };
    child.once('error', (error) => finish(null, error));
    child.once('exit', (code) => finish(code));
    socket.on('close', stop);
    socket.on('error', stop);
  });
}

export default fp(terminalModule, { name: 'module-terminal' });
