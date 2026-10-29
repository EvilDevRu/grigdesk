// Модуль «Терминал» — веб-терминал на «мозге» через WebSocket.
// Нужен, чтобы авторизовать Claude (`claude login`) и чинить что-то руками, не отходя от GrigDesk.
//
// PTY выделяет stdlib Python-helper: stdin/stdout — сырые байты, fd 3 — resize/close.
// Нативных npm-зависимостей нет, но размер меняется у НАСТОЯЩЕГО PTY, а не только у xterm.
import fp from 'fastify-plugin';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { Writable } from 'node:stream';

import { ptyStartEnvironment } from '../../lib/providerInstall/userCliEnvironment.ts';

// Сообщение от клиента: ввод или изменение размера. Разбирается из недоверенного
// JSON, поэтому каждое поле проверяется отдельно.
interface TerminalMessage {
  t?: unknown;
  d?: unknown;
  cols?: unknown;
  rows?: unknown;
}

export const MAX_SESSIONS = 6; // разумный потолок параллельных терминалов
let active = 0;
const HELPER = fileURLToPath(new URL('./pty-helper.py', import.meta.url));

/** Число из недоверенного значения в заданных границах; мусор даёт умолчание. */
function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * PTY получает очищенную пользовательскую среду и запускает shell ровно один раз.
 * Startup-файлы выполняет сам shell, поэтому rc второй раз не source-ится.
 */
export function spawnPty({
  cols,
  rows,
  shell,
  home,
  env = process.env,
  python = process.env.GRIGDESK_TERMINAL_PYTHON || 'python3',
}: {
  cols: number;
  rows: number;
  shell: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  python?: string;
}): ChildProcessWithoutNullStreams {
  return spawn(python, [
    HELPER,
    '--cols', String(cols),
    '--rows', String(rows),
    '--shell', shell,
    '--cwd', home,
    '--control-fd', '3',
  ], {
    cwd: home,
    env: {
      ...env,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
}

async function terminalModule(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { cols?: string; rows?: string } }>('/api/terminal', {
    websocket: true,
  }, (socket, req) => {
    // Доступ проверен глобальным гардом (plugins/auth.js): хуки Fastify выполняются и для
    // WS-роутов, поэтому без валидной сессии сюда не доходят. Прежний `?token=` убран —
    // секрет в query-параметре оседает в логах, cookie этого не делает.
    if (active >= MAX_SESSIONS) { socket.close(1013, 'too many sessions'); return; }

    const cols = clampInt(req.query.cols, 100, 20, 500);
    const rows = clampInt(req.query.rows, 30, 5, 200);
    const shell = process.env.SHELL || '/bin/bash';
    const home = os.homedir();
    let ptyEnv: Record<string, string>;

    try {
      ptyEnv = ptyStartEnvironment(process.env);
    } catch (error) {
      fastify.log.warn({ err: (error as Error).message }, 'terminal: исходное окружение неизвестно');
      socket.close(1011, 'terminal environment unavailable');

      return;
    }

    const child = spawnPty({
      cols,
      rows,
      shell,
      home,
      env: ptyEnv,
    });
    active++;
    fastify.log.info({ pid: child.pid, cols, rows }, 'terminal: PTY запущен');

    // PTY → клиент (сырые байты, включая управляющие последовательности).
    const toClient = (chunk: Buffer) => {
      if (socket.readyState === 1) socket.send(chunk);
    };
    child.stdout.on('data', toClient);
    child.stderr.on('data', toClient);

    // Клиент → PTY. Ввод и управление идут разными fd, поэтому JSON resize
    // невозможно случайно напечатать в shell.
    // Управляющий поток PTY: изменение размера и закрытие идут отдельным fd, чтобы
    // JSON нельзя было случайно напечатать в shell.
    const control = child.stdio[3] as Writable | undefined;

    socket.on('message', (raw: Buffer) => {
      let msg: TerminalMessage;

      try {
        msg = JSON.parse(raw.toString()) as TerminalMessage;
      } catch {
        return;
      }
      if (msg.t === 'in' && typeof msg.d === 'string' && child.stdin.writable) {
        child.stdin.write(msg.d);
      }
      if (msg.t === 'resize' && control?.writable) {
        const nextCols = clampInt(msg.cols, cols, 20, 500);
        const nextRows = clampInt(msg.rows, rows, 5, 200);

        control.write(`${JSON.stringify({ t: 'resize', cols: nextCols, rows: nextRows })}\n`);
      }
    });

    let finished = false;
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, error: Error | null = null) => {
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
      try {
        control?.write(`${JSON.stringify({ t: 'close' })}\n`);
      } catch {
        /* helper уже мёртв */
      }
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
