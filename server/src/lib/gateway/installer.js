// Установка внешнего шлюза одной кнопкой: доступ к VPS → DNS → bootstrap VPS → мозг → проверка.
//
// Зачем визард вообще. Руками это два идемпотентных скрипта (`deploy/gateway/bootstrap.sh` на
// VPS и `brain-setup.sh` на мозге) плюс ДВЕ DNS-записи, которых ни один из них завести не может:
// доступа к чужой зоне у них нет. Ровно эта дыра и оставалась ручной, поэтому визард закрывает
// её в составе установки, а скрипты только запускает — переписывать их в JS нельзя, они остаются
// рабочим ручным путём.
//
// Секреты человека (пароль root, токен Cloudflare, пароль sudo) НЕ СОХРАНЯЮТСЯ НИКУДА: живут
// в замыкании задачи на время установки и умирают вместе с ней. Готовой системе они не нужны
// вовсе — туннель ходит своим ключом, сертификаты Caddy продлевает по HTTP-01. На диск ложится
// только неcекретный слепок (`setup.json`): домен, адрес, когда и чем закончилось.
//
// Порядок шагов выстрадан, а не произволен:
//   keys     — ключ ТУННЕЛЯ заводим раньше VPS: bootstrap хочет его открытую половину, а
//              `brain-setup.sh` создаёт ключ только если файла нет (`[ ! -f "$KEY" ]`), то есть
//              наш подхватит как свой;
//   ssh      — доступ проверяем ДО DNS: ошибка пароля не должна уже переключить публичное имя
//              на неготовый VPS;
//   dns      — записи после SSH, но ДО bootstrap: Caddy на VPS полезет за сертификатом сразу;
//   dns-wait — ждём распространения: у Let's Encrypt лимит 5 неудач в час на имя, и стартовать
//              по неразъехавшемуся DNS означает сжечь его вхолостую;
//   vps/brain— сами скрипты;
//   env      — переменные кокпита (без них шлюз работает, а вход ломается: cookie без Secure);
//   verify   — связь по кругу: наружу на VPS и обратно в туннель.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CloudflareError, ensureGatewayDns, inspectGatewayDns } from './cloudflare.js';
import {
  SshError,
  ensureKeypair,
  execScript,
  installPublicKey,
  keyWorks,
  scanHostKeys,
  uploadFile,
  writeKnownHosts,
} from './ssh.js';

const execFileAsync = promisify(execFile);

/** Хвост журнала установки. Больше человеку не нужно, а SSE и снимок дорожают линейно. */
const LOG_TAIL = 400;

/** Ожидание DNS: полминуты между попытками, пять минут потолок (TTL записей — 60 секунд). */
const DNS_POLL_MS = 15_000;
const DNS_WAIT_MS = 5 * 60_000;

/** Публичные резолверы: спрашивать локальный бессмысленно — он может отдавать кеш провайдера. */
const DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

const STEPS = [
  { key: 'keys', title: 'Ключи доступа' },
  { key: 'ssh', title: 'Доступ к VPS' },
  { key: 'dns', title: 'DNS-записи' },
  { key: 'dns-wait', title: 'Распространение DNS' },
  { key: 'vps', title: 'Настройка VPS' },
  { key: 'brain', title: 'Настройка мозга' },
  { key: 'env', title: 'Переменные кокпита' },
  { key: 'verify', title: 'Проверка связи' },
];

/** Отказ установки с машинным кодом: визард показывает следующий шаг, а не стек. */
export class GatewaySetupError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GatewaySetupError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ─────────────────────────── проверка того, что ввёл человек ─────────────────────────── */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeIp(value) {
  const ip = String(value || '').trim();
  const m = IPV4_RE.exec(ip);
  if (!m) return '';
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return '';
    if (m[i].length > 1 && m[i].startsWith('0')) return '';
  }
  return ip;
}

export function normalizeDomain(value) {
  const d = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return DOMAIN_RE.test(d) ? d : '';
}

/**
 * Разбор формы визарда. Отдельно от запуска: отказ по вводу человек обязан увидеть сразу,
 * а не строкой в журнале установки, которая уже что-то сделала на его сервере.
 */
export function parseSetupInput(body = {}, { requireCloudflarePlan = false } = {}) {
  const domain = normalizeDomain(body.domain);
  if (!domain) throw new GatewaySetupError('bad_domain', 'Домен не похож на домен (пример: cockpit.example.com).');

  const gateway = normalizeIp(body.gateway);
  if (!gateway) throw new GatewaySetupError('bad_gateway', 'Адрес VPS — это IPv4 вида 203.0.113.10.');

  const sshPort = Number(body.sshPort || 22);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new GatewaySetupError('bad_ssh_port', 'Порт SSH — число от 1 до 65535.');
  }

  const sshUser = String(body.sshUser || 'root').trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser)) {
    throw new GatewaySetupError('bad_ssh_user', 'Имя пользователя SSH не похоже на имя пользователя.');
  }

  const acmeEmail = String(body.acmeEmail || '').trim();
  if (acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) {
    throw new GatewaySetupError('bad_email', 'Почта для Let’s Encrypt не похожа на почту.');
  }

  const useCloudflare = !!body.useCloudflare;
  const cloudflareToken = String(body.cloudflareToken || '').trim();
  if (useCloudflare && !cloudflareToken) {
    throw new GatewaySetupError('cloudflare_token_required', 'Для автоматической настройки DNS нужен API-токен Cloudflare.');
  }
  const cloudflareZoneId = String(body.cloudflareZoneId || '').trim();
  if (cloudflareZoneId && !/^[a-f0-9]{32}$/i.test(cloudflareZoneId)) {
    throw new GatewaySetupError('bad_cloudflare_zone', 'Zone ID Cloudflare должен состоять из 32 шестнадцатеричных символов.');
  }
  const cloudflarePlanFingerprint = String(body.cloudflarePlanFingerprint || '').trim().toLowerCase();
  if (cloudflarePlanFingerprint && !/^[a-f0-9]{64}$/.test(cloudflarePlanFingerprint)) {
    throw new GatewaySetupError('bad_cloudflare_plan', 'Отпечаток плана Cloudflare имеет неверный формат.');
  }
  if (useCloudflare && requireCloudflarePlan && !cloudflarePlanFingerprint) {
    throw new GatewaySetupError(
      'cloudflare_plan_required',
      'Сначала перечитай текущие DNS-записи Cloudflare и подтверди план изменений.',
    );
  }

  return {
    domain,
    gateway,
    sshPort,
    sshUser,
    acmeEmail,
    acmeStaging: !!body.acmeStaging,
    useCloudflare,
    cloudflareToken,
    cloudflareZoneId,
    cloudflarePlanFingerprint,
    sshPassword: String(body.sshPassword || ''),
    sudoPassword: String(body.sudoPassword || ''),
    hostKeyFingerprint: String(body.hostKeyFingerprint || '').trim(),
  };
}

/* ─────────────────────────────────── мелкие помощники ─────────────────────────────────── */

/**
 * Ключ туннеля — тот самый `~/.ssh/cockpit-tunnel`, который иначе завёл бы `brain-setup.sh`.
 *
 * Заводим его САМИ и до VPS: bootstrap-у нужна открытая половина (`COCKPIT_TUNNEL_PUBKEY`),
 * а скрипт мозга создаёт ключ только при отсутствии файла — значит подхватит наш и не
 * перезапишет. Имя и путь обязаны совпадать буквально: на них ссылаются юниты туннелей.
 */
async function ensureTunnelKey() {
  const dir = path.join(os.homedir(), '.ssh');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, 'cockpit-tunnel');
  const pubPath = `${keyPath}.pub`;
  try {
    const pub = await fs.readFile(pubPath, 'utf8');
    return { keyPath, publicKey: pub.trim(), created: false };
  } catch {
    /* нет ключа — заводим */
  }
  await fs.rm(keyPath, { force: true });
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'cockpit-tunnel', '-f', keyPath]);
  await fs.chmod(keyPath, 0o600);
  const pub = await fs.readFile(pubPath, 'utf8');
  return { keyPath, publicKey: pub.trim(), created: true };
}

/** Локальный процесс с потоковым выводом — тем же способом, что и удалённый. */
function runLocal(cmd, args, { input = null, timeoutMs = 30 * 60_000, onData, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const pump = (stream, sink) => stream.on('data', (d) => {
      const text = String(d);
      sink(text);
      if (onData) onData(text);
    });
    pump(child.stdout, (t) => { stdout += t; });
    pump(child.stderr, (t) => { stderr += t; });
    if (input !== null) child.stdin.end(input);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e?.message || e}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Один публичный резолвер: отсутствие записи отличается от таймаута/SERVFAIL. */
async function resolvePublicOne(server, name, type) {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers([server]);
  try {
    return await resolver.resolve(name, type);
  } catch (e) {
    if (e?.code === 'ENODATA' || e?.code === 'ENOTFOUND') return [];
    return null;
  }
}

/** Сверить оба публичных резолвера; ошибка любого не может означать «AAAA отсутствует». */
async function resolvePublic(name, type = 'A') {
  const answers = await Promise.all(DNS_SERVERS.map((server) => resolvePublicOne(server, name, type)));
  if (answers.some((item) => item === null)) return null;
  return answers.flat();
}

/** DNS готов лишь когда адрес ОДИН. `includes()` пропускал round-robin со старым VPS. */
export function dnsAnswersMatch(addresses, expected) {
  const unique = [...new Set(Array.isArray(addresses) ? addresses : [])];
  return unique.length === 1 && unique[0] === expected;
}

/** Пустой массив — доказанное отсутствие ответа; `null` означает сбой резолвера. */
export function dnsAnswersAbsent(addresses) {
  return Array.isArray(addresses) && addresses.length === 0;
}

/**
 * Атомарная правка корневого `.env`.
 *
 * Своё место у этих переменных — только он: его читают ВСЕ три способа запуска (юнит systemd,
 * `bin/cockpit`, `bin/restart`). Строки `Environment=` в юните не годятся — `deploy/install.sh`
 * перегенерирует юнит из шаблона на каждом прогоне (docs/cockpit/gotchas.md).
 * Синтаксис — общий знаменатель systemd и `node --env-file`: `KEY=VALUE`, без `export`
 * и без подстановок, поэтому значения проверяем, а не кавычим.
 */
export async function upsertEnvFile(envPath, values) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new GatewaySetupError('bad_env', `Недопустимое имя переменной: ${key}`);
    if (/[\r\n"'\s]/.test(String(value))) {
      throw new GatewaySetupError('bad_env', `Значение ${key} не влезает в синтаксис .env: «${value}»`);
    }
  }

  let text = '';
  try {
    text = await fs.readFile(envPath, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const hadTrailingNewline = text.endsWith('\n');
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const changed = [];

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (idx >= 0) {
      if (lines[idx] === line) continue;
      lines[idx] = line;
      changed.push(key);
    } else {
      lines.push(line);
      changed.push(key);
    }
  }
  if (!changed.length) return { changed, path: envPath };

  const body = `${lines.join('\n')}${hadTrailingNewline || lines.length ? '\n' : ''}`;
  // Временный файл создаём сразу 0600: в `.env` лежат и секреты, и ловить их из чужого
  // процесса между `writeFile` и `chmod` никто не должен.
  const tmp = `${envPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.rename(tmp, envPath);
  return { changed, path: envPath };
}

/* ─────────────────────────────────────── задача ─────────────────────────────────────── */

/**
 * Установщик — один на процесс, задача — одна за раз.
 *
 * Параллельные установки запрещены не из лени: обе полезут править один `.env`, один
 * `authorized_keys` и один Caddyfile, и разбираться в получившемся будет некому.
 */
export function createGatewayInstaller({ config, onEvent = () => {}, log = console }) {
  let job = null;
  let running = false;

  const setupPath = () => path.join(config.gatewayDir, 'setup.json');

  /** Публичный снимок: секретов в нём нет по построению — их и не кладём в `job`. */
  function snapshot() {
    if (!job) return null;
    return {
      id: job.id,
      state: job.state,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      domain: job.domain,
      gateway: job.gateway,
      steps: job.steps,
      manual: job.manual,
      needsRestart: job.needsRestart,
      error: job.error,
      log: job.log,
    };
  }

  function emit() {
    try {
      onEvent(snapshot());
    } catch (e) {
      log.warn?.({ err: e }, 'Шлюз: не смогли отправить прогресс установки');
    }
  }

  function pushLog(text) {
    if (!job) return;
    const lines = String(text).split('\n').map((s) => s.replace(/\s+$/, '')).filter(Boolean);
    if (!lines.length) return;
    job.log.push(...lines);
    if (job.log.length > LOG_TAIL) job.log.splice(0, job.log.length - LOG_TAIL);
    emit();
  }

  function stepState(key, state, detail = '') {
    if (!job) return;
    const s = job.steps.find((x) => x.key === key);
    if (!s) return;
    s.state = state;
    if (detail) s.detail = detail;
    emit();
  }

  function addManual(entry) {
    if (!job) return;
    job.manual.push(entry);
    emit();
  }

  /* ── шаги ── */

  async function stepKeys() {
    stepState('keys', 'run');
    const setup = await ensureKeypair(config.gatewayDir);
    const tunnel = await ensureTunnelKey();
    pushLog(tunnel.created ? 'Завёл ключ туннеля ~/.ssh/cockpit-tunnel' : 'Ключ туннеля ~/.ssh/cockpit-tunnel уже был');
    stepState('keys', 'ok', tunnel.created ? 'ключ туннеля создан' : 'ключи на месте');
    return { setup, tunnel };
  }

  /** Read-only план для точного подтверждения в форме. ID записей наружу не отдаём. */
  async function inspectDns(input) {
    if (!input.useCloudflare) {
      throw new GatewaySetupError('cloudflare_disabled', 'Автоматическая настройка Cloudflare не включена.');
    }
    const { zone, plan, fingerprint } = await inspectGatewayDns({
      token: input.cloudflareToken,
      domain: input.domain,
      ip: input.gateway,
      zoneId: input.cloudflareZoneId,
    });
    return {
      zone: { name: zone.name },
      domain: plan.domain,
      ip: input.gateway,
      records: plan.desired.map(({ name, action }) => ({ name, action })),
      removed: plan.removed.map(({ type, name, content, proxied }) => ({ type, name, content, proxied })),
      preserved: plan.preserved.length,
      fingerprint,
    };
  }

  async function stepDns(input) {
    if (!input.useCloudflare) {
      stepState('dns', 'skip', 'записи заводит человек');
      addManual({
        key: 'dns',
        title: 'Завести две A-записи',
        text: `У провайдера DNS домена ${input.domain} должны быть две записи типа A на адрес `
          + `${input.gateway}: «${input.domain}» и «*.${input.domain}». Если домен на Cloudflare — `
          + 'облако должно быть СЕРЫМ (proxied выключен), иначе вернутся ограничения прокси: '
          + '100 секунд на ответ и 100 МБ на тело.',
      });
      return null;
    }
    if (!input.cloudflarePlanFingerprint) {
      throw new GatewaySetupError(
        'cloudflare_plan_required',
        'Сначала перечитай текущие DNS-записи Cloudflare и подтверди план изменений.',
      );
    }
    stepState('dns', 'run');
    const res = await ensureGatewayDns({
      token: input.cloudflareToken,
      domain: input.domain,
      ip: input.gateway,
      zoneId: input.cloudflareZoneId,
      expectedFingerprint: input.cloudflarePlanFingerprint,
    });
    const words = res.records
      .map((r) => `${r.name}: ${{ created: 'создана', updated: 'исправлена', unchanged: 'уже верна' }[r.action]}`)
      .join('; ');
    pushLog(`Cloudflare, зона ${res.zone.name} — ${words}`);
    if (res.removed.length) {
      const removed = res.removed.map((r) => `${r.type} ${r.name} → ${r.content || 'пусто'}`).join('; ');
      pushLog(`Cloudflare: удалены лишние записи (${res.removed.length}): ${removed}`);
    }
    // Оранжевое облако было и его сняли — это важно сказать вслух: человек включал прокси
    // осознанно, а мы его выключили ради работоспособности кокпита.
    if (res.records.some((r) => r.wasProxied)) {
      pushLog('Прокси Cloudflare (оранжевое облако) выключен — иначе ход агента рвётся на 100 секундах.');
    }
    stepState('dns', 'ok', `${words}${res.removed.length ? `; удалено лишних: ${res.removed.length}` : ''}`);
    return res;
  }

  async function stepSsh(input, keys) {
    stepState('ssh', 'run');
    const scan = await scanHostKeys(input.gateway, input.sshPort);
    // Отпечаток человек подтвердил на пробе. Разошёлся — либо не тот сервер, либо чужой
    // между нами; пароль root в такое соединение отдавать нельзя.
    if (input.hostKeyFingerprint && scan.primary?.hash && input.hostKeyFingerprint !== scan.primary.hash) {
      throw new GatewaySetupError(
        'host_key_changed',
        `Ключ хоста ${input.gateway} не тот, что показывали на проверке `
          + `(было ${input.hostKeyFingerprint}, стало ${scan.primary.hash}). Установка остановлена.`,
      );
    }
    const knownHosts = await writeKnownHosts(config.gatewayDir, scan.lines);

    const common = {
      host: input.gateway, port: input.sshPort, user: input.sshUser, keyPath: keys.setup.keyPath, knownHosts,
    };
    if (await keyWorks(common)) {
      pushLog('Ключ кокпита на сервере уже есть — пароль не нужен.');
      stepState('ssh', 'ok', 'вход по ключу');
      return { knownHosts };
    }
    if (!input.sshPassword) {
      throw new GatewaySetupError('ssh_password_required', `Сервер не пускает по ключу — нужен пароль ${input.sshUser}.`);
    }
    await installPublicKey({
      gatewayDir: config.gatewayDir,
      host: input.gateway,
      port: input.sshPort,
      user: input.sshUser,
      password: input.sshPassword,
      publicKey: keys.setup.publicKey,
      knownHosts,
    });
    pushLog('Ключ кокпита установлен — дальше пароль не понадобится ни разу.');
    stepState('ssh', 'ok', 'ключ установлен');
    return { knownHosts };
  }

  async function stepDnsWait(input) {
    stepState('dns-wait', 'run');
    // Случайная метка — чтобы проверить именно ЗВЁЗДОЧКУ, а не попасть в кеш соседнего имени.
    const probe = `probe-${crypto.randomBytes(4).toString('hex')}.${input.domain}`;
    const sandbox = `p5191.${input.domain}`;
    const deadline = Date.now() + DNS_WAIT_MS;
    let last = '';
    for (;;) {
      const [base4, wild4, sandbox4, base6, wild6, sandbox6] = await Promise.all([
        resolvePublic(input.domain, 'A'),
        resolvePublic(probe, 'A'),
        resolvePublic(sandbox, 'A'),
        resolvePublic(input.domain, 'AAAA'),
        resolvePublic(probe, 'AAAA'),
        resolvePublic(sandbox, 'AAAA'),
      ]);
      const ipv4Ok = [base4, wild4, sandbox4].every((answers) => dnsAnswersMatch(answers, input.gateway));
      const ipv6Ok = [base6, wild6, sandbox6].every(dnsAnswersAbsent);
      if (ipv4Ok && ipv6Ok) {
        pushLog(`DNS разъехался однозначно: ${input.domain} и *.${input.domain} → ${input.gateway}; AAAA нет`);
        stepState('dns-wait', 'ok', 'записи видны публичным резолверам');
        return;
      }
      const show = (v) => (Array.isArray(v) ? (v.join(', ') || 'нет ответа') : 'ошибка резолвера');
      last = `${input.domain}: A ${show(base4)}, AAAA ${show(base6)}; `
        + `*.${input.domain}: A ${show(wild4)}, AAAA ${show(wild6)}; `
        + `${sandbox}: A ${show(sandbox4)}, AAAA ${show(sandbox6)}`;
      if (Date.now() >= deadline) break;
      stepState('dns-wait', 'run', last);
      await new Promise((r) => { setTimeout(r, DNS_POLL_MS); });
    }
    throw new GatewaySetupError(
      'dns_not_propagated',
      `За ${Math.round(DNS_WAIT_MS / 60000)} минут DNS не показал нужный адрес (${last}). `
        + 'Дальше идти нельзя: Caddy на VPS пойдёт за сертификатом и сожжёт попытки Let’s Encrypt '
        + '(лимит — пять неудач в час на имя). Проверь записи и запусти установку заново — все шаги идемпотентны.',
    );
  }

  async function stepVps(input, keys, ssh) {
    stepState('vps', 'run');
    const local = path.join(config.rootDir, 'deploy', 'gateway', 'bootstrap.sh');
    const content = await fs.readFile(local, 'utf8');
    const remotePath = '/root/cockpit-gateway-bootstrap.sh';
    const common = {
      host: input.gateway, port: input.sshPort, user: input.sshUser, keyPath: keys.setup.keyPath, knownHosts: ssh.knownHosts,
    };
    await uploadFile({ ...common, remotePath, content, mode: '0700' });
    pushLog(`Скрипт установки шлюза загружен: ${remotePath}`);

    const env = {
      COCKPIT_DOMAIN: input.domain,
      COCKPIT_TUNNEL_PUBKEY: keys.tunnel.publicKey,
      COCKPIT_SSH_PORT: String(input.sshPort),
    };
    if (input.acmeEmail) env.COCKPIT_ACME_EMAIL = input.acmeEmail;
    if (input.acmeStaging) env.COCKPIT_ACME_STAGING = '1';

    const res = await execScript({
      ...common,
      script: `set -euo pipefail\nbash ${remotePath}\n`,
      env,
      timeoutMs: 20 * 60_000,
      onData: pushLog,
    });
    if (res.code !== 0) {
      throw new GatewaySetupError('vps_bootstrap_failed', `Скрипт на VPS вышел с кодом ${res.code}. Причина — в журнале выше.`);
    }
    stepState('vps', 'ok', 'Caddy и пользователь туннеля готовы');
  }

  async function stepBrain(input) {
    const script = path.join(config.rootDir, 'deploy', 'gateway', 'brain-setup.sh');
    const args = [
      script,
      '--gateway', input.gateway,
      '--domain', input.domain,
      '--ssh-port', String(input.sshPort),
    ];
    const manualCommand = `sudo ${args.map((a) => (/[^\w@%+=:,./-]/.test(a) ? `'${a}'` : a)).join(' ')}`;

    if (!input.sudoPassword) {
      stepState('brain', 'skip', 'нужен пароль sudo');
      addManual({
        key: 'brain',
        title: 'Поднять туннели на мозге',
        text: 'Скрипту нужен root: он ставит Caddy для стендов и три юнита systemd. Выполни команду '
          + 'в терминале кокпита — она идемпотентна, повтор безопасен.',
        command: manualCommand,
      });
      return false;
    }

    stepState('brain', 'run');
    // Пароль отдаём ОДИН раз и отдельной командой (`sudo -k -S true`), а сам скрипт запускаем
    // уже с `-n` и закрытым stdin: иначе пароль остался бы в трубе, которую наследует дочерний
    // процесс. Отметка sudo проверяется один раз на старте, поэтому долгий apt её не «просрочит».
    const prime = await runLocal('sudo', ['-k', '-S', '-p', '', '--', 'true'], {
      input: `${input.sudoPassword}\n`,
      timeoutMs: 30_000,
    });
    if (prime.code !== 0) {
      throw new GatewaySetupError(
        'sudo_password_rejected',
        `sudo не принял пароль: ${prime.stderr.trim() || `код ${prime.code}`}`,
      );
    }
    const res = await runLocal('sudo', ['-n', '--', ...args], {
      timeoutMs: 20 * 60_000,
      onData: pushLog,
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
    if (res.code !== 0) {
      throw new GatewaySetupError('brain_setup_failed', `Скрипт мозга вышел с кодом ${res.code}. Причина — в журнале выше.`);
    }
    // Скрипт включает юниты со снисхождением (`|| warn`) и НЕ падает, если туннель не поднялся,
    // — поэтому состояние проверяем сами, а не верим коду возврата.
    const units = ['cockpit-tunnel-app', 'cockpit-tunnel-sandbox', 'cockpit-sandbox-proxy'];
    const dead = [];
    for (const unit of units) {
      const st = await runLocal('systemctl', ['is-active', unit], { timeoutMs: 15_000 });
      const state = st.stdout.trim() || st.stderr.trim();
      if (state !== 'active') dead.push(`${unit} (${state || 'нет ответа'})`);
    }
    if (dead.length) {
      // Туннель ходит ЧЕРЕЗ VPN и стоит на тех же воротах, что кокпит, поэтому первый вопрос —
      // жив ли VPN. Спрашиваем те же ворота, что и юнит: иначе ожидание маршрута читается как
      // поломка, и человек идёт чинить работающее.
      const gate = await runLocal(path.join(config.rootDir, 'deploy', 'require-vpn.sh'), [], { timeoutMs: 15_000 });
      const why = gate.code === 0
        ? 'VPN на месте, значит дело не в нём — смотри `journalctl -u cockpit-tunnel-app -n 50`.'
        : `VPN сейчас не поднят (${gate.stderr.trim() || gate.stdout.trim() || `код ${gate.code}`}). `
          + 'Туннель ходит через него намеренно и ждёт маршрута — юниты поднимутся сами, как только '
          + 'появится VPN. Ничего в его настройках менять не нужно.';
      throw new GatewaySetupError('tunnel_units_down', `Юниты не поднялись: ${dead.join(', ')}. ${why}`);
    }
    stepState('brain', 'ok', 'туннели подняты');
    return true;
  }

  async function stepEnv(input) {
    stepState('env', 'run');
    const res = await upsertEnvFile(config.envPath, {
      COCKPIT_TRUST_PROXY: '127.0.0.1',
      COCKPIT_PUBLIC_DOMAIN: input.domain,
    });
    if (res.changed.length) {
      pushLog(`В .env записаны: ${res.changed.join(', ')}`);
      job.needsRestart = true;
      stepState('env', 'ok', 'нужен перезапуск сервера');
    } else {
      stepState('env', 'ok', 'уже были');
    }
  }

  /* ── проверка связи ── */

  async function probeUrl(url, { timeoutMs = 20_000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, error: e?.cause?.code || e?.message || String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Проверка по кругу: наружу на VPS и обратно к себе в туннель. Отдельная функция —
   * её же зовёт кнопка «Проверить связь» после ручного шага и после перезапуска.
   */
  async function verify({ domain, gateway, sshPort, sshUser }) {
    const checks = [];
    const target = normalizeDomain(domain);
    if (!target) throw new GatewaySetupError('bad_domain', 'Проверять нечего: домен не задан.');

    // 1. Порты туннелей НА VPS: без них Caddy стучится в пустоту.
    try {
      const keys = await ensureKeypair(config.gatewayDir);
      const knownHosts = path.join(config.gatewayDir, 'known_hosts');
      const res = await execScript({
        host: gateway,
        port: sshPort || 22,
        user: sshUser || 'root',
        keyPath: keys.keyPath,
        knownHosts,
        script: "ss -ltn | grep -E '127.0.0.1:(18140|18141)' || true\n",
        timeoutMs: 30_000,
      });
      const app = res.stdout.includes(':18140');
      const sandbox = res.stdout.includes(':18141');
      checks.push({
        key: 'tunnels',
        title: 'Туннели на VPS',
        ok: app && sandbox,
        detail: app && sandbox
          ? 'оба порта слушают (18140 кокпит, 18141 стенды)'
          : `не слушают: ${[!app && '18140', !sandbox && '18141'].filter(Boolean).join(', ')} — `
            + 'смотри `journalctl -u cockpit-tunnel-app -n 50` на мозге',
      });
    } catch (e) {
      checks.push({ key: 'tunnels', title: 'Туннели на VPS', ok: false, detail: e?.message || String(e) });
    }

    // 2. Круг целиком: наружу к VPS и обратно вниз по туннелю. Ручка публичная — 200 ждём
    //    и без сессии, поэтому проверка ничего не открывает наружу.
    const state = await probeUrl(`https://${target}/api/auth/state`);
    checks.push({
      key: 'cockpit',
      title: 'Кокпит через шлюз',
      ok: state.ok && state.status === 200,
      detail: state.ok
        ? `https://${target}/api/auth/state → ${state.status}`
        : `не открылся: ${state.error}. Если ставили «тестовый ACME», сертификат и должен быть недоверенным.`,
    });

    // 3. Стенды: 401 — правильный ответ, он доказывает сразу три вещи — что разъехался
    //    wildcard, что Caddy выдал сертификат по требованию и что перед стендами стоит вход.
    if (!config.publicDomain) {
      checks.push({
        key: 'sandbox',
        title: 'Стенды через шлюз',
        ok: false,
        detail: 'проверим после перезапуска сервера: без COCKPIT_PUBLIC_DOMAIN кокпит не разрешает выдачу сертификата',
      });
    } else {
      const sandbox = await probeUrl(`https://p5191.${target}/`);
      checks.push({
        key: 'sandbox',
        title: 'Стенды через шлюз',
        ok: sandbox.ok && sandbox.status === 401,
        detail: sandbox.ok
          ? `https://p5191.${target}/ → ${sandbox.status}${sandbox.status === 401 ? ' (так и должно быть: вход спрашивают до стенда)' : ''}`
          : `не открылся: ${sandbox.error}`,
      });
    }

    return { ok: checks.every((c) => c.ok), checks };
  }

  /* ── прогон ── */

  async function run(input) {
    if (running) throw new GatewaySetupError('setup_busy', 'Установка уже идёт.');
    running = true;
    job = {
      id: crypto.randomUUID(),
      state: 'running',
      startedAt: Date.now(),
      finishedAt: 0,
      domain: input.domain,
      gateway: input.gateway,
      steps: STEPS.map((s) => ({ ...s, state: 'wait', detail: '' })),
      manual: [],
      needsRestart: false,
      error: null,
      log: [],
    };
    emit();

    try {
      const keys = await stepKeys();
      const ssh = await stepSsh(input, keys);
      await stepDns(input);
      await stepDnsWait(input);
      await stepVps(input, keys, ssh);
      const brainDone = await stepBrain(input);
      await stepEnv(input);

      if (brainDone) {
        stepState('verify', 'run');
        const res = await verify(input);
        stepState('verify', res.ok ? 'ok' : 'fail',
          res.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.title}: ${c.detail}`).join(' · '));
      } else {
        stepState('verify', 'skip', 'после ручного шага — кнопкой «Проверить связь»');
      }

      // Шага «добавь в v2rayN правило <адрес шлюза> → direct» здесь БЫЛО и больше нет —
      // не возвращать. Решение человека: туннель ходит через VPN, VPN важнее скорости
      // туннеля. Правка чужого конфига ради латентности того не стоит, а цена принята —
      // двойной крюк до VPS и падение туннеля вместе с VPN (юниты его же и ждут воротами
      // require-vpn.sh, см. deploy/gateway/brain-setup.sh). Пустой manual — это успех
      // визарда: карточка «Осталось сделать руками» тогда не показывается вовсе.

      job.state = 'done';
      job.finishedAt = Date.now();
      await saveSetup(input);
      emit();
      return snapshot();
    } catch (e) {
      const code = e?.code || (e instanceof CloudflareError || e instanceof SshError ? e.code : 'setup_failed');
      job.state = 'failed';
      job.finishedAt = Date.now();
      job.error = { code, message: e?.message || String(e) };
      const current = job.steps.find((s) => s.state === 'run');
      if (current) stepState(current.key, 'fail', e?.message || String(e));
      log.error?.({ err: e }, 'Шлюз: установка не прошла');
      emit();
      return snapshot();
    } finally {
      running = false;
    }
  }

  /** Слепок установки. Секретов в нём нет — только то, что и так видно человеку в форме. */
  async function saveSetup(input) {
    await fs.mkdir(config.gatewayDir, { recursive: true, mode: 0o700 });
    const data = {
      schemaVersion: 1,
      domain: input.domain,
      gateway: input.gateway,
      sshPort: input.sshPort,
      sshUser: input.sshUser,
      acmeStaging: !!input.acmeStaging,
      dns: input.useCloudflare ? 'cloudflare' : 'manual',
      installedAt: Date.now(),
    };
    const tmp = `${setupPath()}.tmp-${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, setupPath());
    return data;
  }

  async function readSetup() {
    try {
      return JSON.parse(await fs.readFile(setupPath(), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Проба сервера ДО ввода пароля: жив ли, и с каким отпечатком.
   *
   * Отпечаток показываем человеку и требуем подтвердить: доверие «по первому подключению»
   * плюс пароль root — это ровно тот случай, когда чужой посередине получает и то и другое.
   */
  async function probe({ gateway, sshPort = 22, sshUser = 'root' }) {
    const ip = normalizeIp(gateway);
    if (!ip) throw new GatewaySetupError('bad_gateway', 'Адрес VPS — это IPv4 вида 203.0.113.10.');
    const scan = await scanHostKeys(ip, sshPort);
    const keys = await ensureKeypair(config.gatewayDir);
    let hasKey = false;
    try {
      const knownHosts = await writeKnownHosts(config.gatewayDir, scan.lines);
      hasKey = await keyWorks({ host: ip, port: sshPort, user: sshUser, keyPath: keys.keyPath, knownHosts });
    } catch {
      hasKey = false;
    }
    return {
      fingerprint: scan.primary?.hash || '',
      fingerprintType: scan.primary?.type || '',
      fingerprints: scan.fingerprints,
      // Ключ уже принят — значит пароль не нужен вовсе (повторная установка).
      passwordNeeded: !hasKey,
    };
  }

  return {
    run,
    verify,
    probe,
    inspectDns,
    readSetup,
    status: () => snapshot(),
    get busy() { return running; },
  };
}
