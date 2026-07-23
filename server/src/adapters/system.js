// SystemAdapter — нагрузка «мозга» (домашнего ПК): CPU и RAM.
// CPU% считаем по разнице снимков os.cpus() на интервале (loadavg врёт на многоядерных).
import os from 'node:os';

export class SystemAdapter {
  constructor({ intervalMs = 2000 } = {}) {
    this.percent = 0;
    this._prev = this._snapshot();
    // Периодический пересчёт CPU% (unref — не держит event loop).
    this._timer = setInterval(() => this._tick(), intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  _snapshot() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      for (const t of Object.values(c.times)) total += t;
      idle += c.times.idle;
    }
    return { idle, total };
  }

  _tick() {
    const cur = this._snapshot();
    const dIdle = cur.idle - this._prev.idle;
    const dTotal = cur.total - this._prev.total;
    this._prev = cur;
    this.percent = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
  }

  /** Текущий снимок нагрузки. */
  read() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      cpu: {
        percent: this.percent,
        cores: os.cpus().length,
        load1: +os.loadavg()[0].toFixed(2),
      },
      mem: {
        totalGb: +(total / 1024 ** 3).toFixed(1),
        usedGb: +(used / 1024 ** 3).toFixed(1),
        freeGb: +(free / 1024 ** 3).toFixed(1),
        percent: Math.round((used / total) * 100),
      },
    };
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }
}
