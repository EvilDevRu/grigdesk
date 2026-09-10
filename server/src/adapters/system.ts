// SystemAdapter — нагрузка «мозга» (домашнего ПК): CPU и RAM (вкл. swap).
// CPU% считаем по разнице снимков os.cpus() на интервале (loadavg врёт на многоядерных).
import os from 'node:os';
import fs from 'node:fs';

// Снимок памяти в байтах. `null` означает, что /proc недоступен, — тогда цифры
// берутся у os, и swap честно считается нулём.
interface MemInfo {
  memTotal: number;
  memAvail: number;
  swapTotal: number;
  swapFree: number;
}

// Публичный адрес «мозга»: важен при VPN, поэтому едет рядом с нагрузкой.
interface EgressNet {
  ip: string;
  country: string;
  countryCode: string;
}

// Память из /proc/meminfo (Linux): точнее os.freemem (MemAvailable) + swap.
function readMeminfo(): MemInfo | null {
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k: string) => {
      const m = t.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'));

      return m ? Number(m[1]) * 1024 : 0;
    };
    return { memTotal: g('MemTotal'), memAvail: g('MemAvailable'), swapTotal: g('SwapTotal'), swapFree: g('SwapFree') };
  } catch { return null; }
}

export class SystemAdapter {
  percent = 0;

  net: EgressNet | null = null;

  private _prev: { idle: number; total: number };

  private readonly _timer: ReturnType<typeof setInterval>;

  private readonly _netTimer: ReturnType<typeof setInterval>;

  constructor({ intervalMs = 2000, netIntervalMs = 60000 }: {
    intervalMs?: number;
    netIntervalMs?: number;
  } = {}) {
    this._prev = this._snapshot();
    // Периодический пересчёт CPU% (unref — не держит event loop).
    this._timer = setInterval(() => this._tick(), intervalMs);
    if (this._timer.unref) this._timer.unref();

    // Публичный egress-IP + страна «мозга» (важно при VPN). Фоновый рефреш, кеш.
    this._refreshNet();
    this._netTimer = setInterval(() => this._refreshNet(), netIntervalMs);
    if (this._netTimer.unref) this._netTimer.unref();
  }

  /**
   * Определяет внешний IP и страну через публичные гео-сервисы (два фоллбэка).
   * При сбое сохраняет предыдущее значение (транзиентную ошибку не роняем в null).
   */
  async _refreshNet(): Promise<void> {
    const timeout = (ms: number) => {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);

      return { signal: c.signal, done: () => clearTimeout(t) };
    };
    // 1) ip-api.com (http, щедрый лимит) → {query, country, countryCode}
    try {
      const s = timeout(4000);
      const r = await fetch('http://ip-api.com/json/?fields=status,query,country,countryCode', { signal: s.signal });
      s.done();
      const j = await r.json() as {
        status?: string; query?: string; country?: string; countryCode?: string;
      };
      if (j && j.status === 'success' && j.query) { this.net = { ip: j.query, country: j.country || '', countryCode: (j.countryCode || '').toUpperCase() }; return; }
    } catch { /* пробуем фоллбэк */ }
    // 2) ipinfo.io (https) → {ip, country}
    try {
      const s = timeout(4000);
      const r = await fetch('https://ipinfo.io/json', { signal: s.signal, headers: { Accept: 'application/json' } });
      s.done();
      const j = await r.json() as { ip?: string; country?: string };
      if (j && j.ip) { this.net = { ip: j.ip, country: j.country || '', countryCode: (j.country || '').toUpperCase() }; return; }
    } catch { /* оставляем прошлое значение */ }
  }

  _snapshot(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      for (const t of Object.values(c.times)) total += t;
      idle += c.times.idle;
    }
    return { idle, total };
  }

  _tick(): void {
    const cur = this._snapshot();
    const dIdle = cur.idle - this._prev.idle;
    const dTotal = cur.total - this._prev.total;
    this._prev = cur;
    this.percent = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
  }

  /**
   * Текущий снимок нагрузки. Цифра в шапке (totalGb/usedGb/percent) — ОЗУ вместе со swap:
   * это общее давление на память. Всплывашке нужна разбивка, поэтому физическая память и
   * подкачка едут ещё и по отдельности: 90% занятого ОЗУ и 90% занятого swap — совсем разные
   * новости, в сумме они неразличимы.
   */
  read() {
    const mi = readMeminfo();
    let ramTotal: number; let ramFree: number; let swapTotal: number; let swapFree: number;
    if (mi && mi.memTotal) {
      ramTotal = mi.memTotal; ramFree = mi.memAvail;   // MemAvailable, а не MemFree: кеш отдаётся под запрос
      swapTotal = mi.swapTotal; swapFree = mi.swapFree;
    } else {
      ramTotal = os.totalmem(); ramFree = os.freemem(); swapTotal = 0; swapFree = 0;
    }
    const total = ramTotal + swapTotal;   // ОЗУ + swap
    const free = ramFree + swapFree;
    const used = total - free;
    const gb = (b: number) => +(b / 1024 ** 3).toFixed(1);
    const pct = (u: number, t: number) => (t > 0 ? Math.round((u / t) * 100) : 0);
    return {
      cpu: { percent: this.percent, cores: os.cpus().length, load1: +(os.loadavg()[0] ?? 0).toFixed(2) },
      mem: {
        totalGb: gb(total), usedGb: gb(used), freeGb: gb(free),
        percent: pct(used, total),
        ramTotalGb: gb(ramTotal), ramUsedGb: gb(ramTotal - ramFree), ramFreeGb: gb(ramFree),
        ramPercent: pct(ramTotal - ramFree, ramTotal),
        swapTotalGb: gb(swapTotal), swapUsedGb: gb(swapTotal - swapFree),
        swapPercent: pct(swapTotal - swapFree, swapTotal),
      },
      net: this.net,
    };
  }

  stop(): void {
    if (this._timer) clearInterval(this._timer);
    if (this._netTimer) clearInterval(this._netTimer);
  }
}
