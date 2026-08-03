import net from 'node:net';
import { domainToASCII } from 'node:url';

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain']);

export function normalizeEgressHost(hostname) {
  const value = domainToASCII(String(hostname ?? '').trim().replace(/\.$/, '').toLowerCase());
  if (!value || value.includes('\0') || value.includes('/')) throw new Error('invalid_egress_host');
  if (net.isIP(value)) throw new Error('ip_literal_forbidden');
  if (BLOCKED_HOSTS.has(value) || value.endsWith('.localhost') || value.endsWith('.local')) {
    throw new Error('local_hostname_forbidden');
  }
  return value;
}

export function isBlockedEgressIp(address) {
  if (net.isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
      (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
      (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
      (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
      octets[0] >= 224;
  }
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice('::ffff:'.length);
      if (net.isIP(mapped) === 4) return isBlockedEgressIp(mapped);
      const halves = mapped.split(':');
      if (halves.length === 2) {
        const v4 = halves.flatMap((half) => {
          const n = Number.parseInt(half, 16);
          return [(n >>> 8) & 255, n & 255];
        }).join('.');
        if (net.isIP(v4) === 4) return isBlockedEgressIp(v4);
      }
      return true;
    }
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('ff') || value.startsWith('100:') || value.startsWith('2001:db8:') || value === 'fe80::1';
  }
  return true;
}

export function validateEgressTarget(rawUrl, { allowedHosts, allowedPorts = [443] }) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('egress_url_forbidden');
  const host = normalizeEgressHost(url.hostname);
  const allowed = new Set(allowedHosts.map(normalizeEgressHost));
  if (!allowed.has(host)) throw new Error('egress_host_not_allowlisted');
  const port = Number(url.port || 443);
  if (!allowedPorts.includes(port)) throw new Error('egress_port_not_allowlisted');
  return { host, port, url };
}

export function assertResolvedEgressAddresses(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('egress_dns_empty');
  for (const address of addresses) {
    if (isBlockedEgressIp(address)) throw new Error('egress_address_forbidden');
  }
  return addresses;
}
