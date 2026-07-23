// Менеджер `code serve-web` — VS Code в браузере на «мозге».
// Ленивый старт (по первому обращению из раздела «Код»), держим один экземпляр на все задачи
// (папка открывается через ?folder=… в URL). Слушает 127.0.0.1 — наружу только через прокси кокпита.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

export class VscodeServer {
  /** @param {{ bin:string, port:number, basePath:string, dataDir:string }} opts */
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.starting = null; // Promise, пока идёт запуск (чтобы не плодить процессы)
    this.lastError = null;
  }

  /** Отвечает ли serve-web на своём порту (реальный HTTP-пинг). */
  ping(timeoutMs = 1500) {
    const { port, basePath } = this.opts;
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `${basePath}/`, timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode === 200); // 200 = сборка готова; 202 = ещё качается
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  /** Текущий статус для UI. */
  async status() {
    const up = await this.ping();
    return { running: up, booting: !up && !!this.child, port: this.opts.port, basePath: this.opts.basePath, error: this.lastError };
  }

  /** Гарантирует, что serve-web запущен и отвечает. Идемпотентно. */
  async ensure() {
    if (await this.ping()) return { running: true };
    if (this.starting) return this.starting;

    this.starting = (async () => {
      this.lastError = null;
      const { bin, port, basePath, dataDir } = this.opts;
      fs.mkdirSync(dataDir, { recursive: true });
      // Прежний живой процесс (после рестарта сервера кокпита) переиспользуем по пингу.
      if (!this.child || this.child.exitCode !== null) {
        this.child = spawn(bin, [
          'serve-web',
          '--host', '127.0.0.1',
          '--port', String(port),
          '--without-connection-token',
          '--accept-server-license-terms',
          '--server-base-path', basePath,
          '--server-data-dir', dataDir,
        ], { stdio: 'ignore', detached: false });
        this.child.on('exit', () => { this.child = null; });
      }
      // Ждём готовности (первый запуск качает веб-сборку — до ~60с).
      for (let i = 0; i < 60; i++) {
        if (await this.ping()) { this.starting = null; return { running: true }; }
        await new Promise((r) => setTimeout(r, 1500));
      }
      this.starting = null;
      this.lastError = 'serve-web не поднялся за отведённое время (возможно, качается веб-сборка — нужна сеть)';
      return { running: false, error: this.lastError };
    })();
    return this.starting;
  }

  stop() {
    if (this.child) { try { this.child.kill(); } catch { /* уже мёртв */ } this.child = null; }
  }
}
