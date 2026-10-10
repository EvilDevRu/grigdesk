import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Проверяет маршрут до конкретного уже разрешённого числового адреса посредника.
 * Глобальное отключение стартовых VPN-ворот не разрешает публичный dial мобильной связи.
 */
export async function relayVpnGate(ip: string): Promise<boolean> {
  if (!isIP(ip)) {
    return false;
  }

  try {
    const family = isIP(ip) === 6 ? '-6' : '-4';
    const args = ['-json', family, 'route', 'get', ip];

    if (process.getuid) {
      args.push('uid', String(process.getuid()));
    }

    const result = await execute('ip', args, {
      timeout: 1000,
      maxBuffer: 8192,
    });
    const routes = JSON.parse(result.stdout);
    const iface = Array.isArray(routes) ? routes[0]?.dev : null;
    const expected = process.env.COCKPIT_VPN_IFACE;

    if (
      typeof iface !== 'string' ||
      !/^[A-Za-z0-9_.:+-]{1,15}$/.test(iface) ||
      (expected && iface !== expected)
    ) {
      return false;
    }

    if (!expected) {
      await fs.access(`/sys/class/net/${iface}/tun_flags`);
    }

    const state = (await fs.readFile(`/sys/class/net/${iface}/operstate`, 'utf8')).trim();

    return state === 'up' || state === 'unknown';
  } catch {
    return false;
  }
}
