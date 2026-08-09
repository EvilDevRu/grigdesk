// Локальный HTTPS: свой корневой сертификат (CA) + лист на адреса этой машины.
//
// Зачем вообще: PWA не существует без secure context — на `http://<адрес в сети>:8140`
// `navigator.serviceWorker` попросту отсутствует. Публичный сертификат на приватный адрес
// не выпишет никто, поэтому дома выход один — свой CA, разово установленный на устройства.
//
// Почему CA + лист, а не одиночный самоподписанный: при смене адреса перевыпускается ТОЛЬКО лист,
// устройства не трогаем — они доверяют корню. Одиночный пришлось бы разносить руками каждый раз.
//
// Ключ корня — самый опасный файл хозяйства (им подписывается сертификат на любое имя), поэтому:
// он лежит ВНЕ репозитория (плагин «Код» отдаёт по HTTP любой файл под деревом проекта, а
// `server/.state` — внутри дерева), и на корне стоят nameConstraints — украденный ключ не
// подпишет публичный домен.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

const exec = promisify(execFile);

// Срок листа. Браузеры отказываются доверять сертификатам длиннее 398 дней; берём год с запасом.
// Продление — кнопкой «Перевыпустить»: устройства при этом не трогаются.
const LEAF_DAYS = 397;
// Корень живёт долго: его смена = обход всех устройств.
const CA_DAYS = 3650;
const MAX_ADDRESSES = 8;

// Радиус поражения украденного ключа CA. Список широкий намеренно: смена роутера или подсети
// не должна требовать перевыпуска КОРНЯ, а публичный интернет он всё равно исключает.
const NAME_CONSTRAINTS = [
  'critical',
  'permitted;IP:10.0.0.0/255.0.0.0',
  'permitted;IP:172.16.0.0/255.240.0.0',
  'permitted;IP:192.168.0.0/255.255.0.0',
  'permitted;IP:127.0.0.0/255.0.0.0',
  'permitted;DNS:localhost',
].join(',');

/**
 * Пути, которые http-слушатель отдаёт КЛИЕНТАМ ИЗ СЕТИ (всё остальное — редирект на https).
 *
 * Ровно два, и оба нужны, чтобы установить корень: без них планшет попадает в ловушку —
 * забрать корень можно только по https, а https без корня показывает предупреждение.
 * Список общий с гардом авторизации (`plugins/auth.js`): разъедутся — QR молча перестанет
 * работать, и причину будут искать полдня.
 */
export const PUBLIC_HTTP_ROUTES = new Set([
  '/api/settings/tls/ca.crt',
  '/api/settings/tls/ca.svg',
]);

/** Ошибка входных данных (400), а не сбой генерации (500). */
export class TlsInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TlsInputError';
  }
}

export function isLoopbackAddress(addr) {
  if (!addr) return false;
  const ip = String(addr).replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  return net.isIPv4(ip) && ip.startsWith('127.');
}

/**
 * Приватный адрес — то есть «из дома», а не из интернета.
 * Нужен там, где отдаём корень без сессии: наружу через шлюз он уходить не должен.
 */
export function isPrivateAddress(addr) {
  if (!addr) return false;
  const ip = String(addr).replace(/^::ffff:/, '');
  if (isLoopbackAddress(ip)) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    // fc00::/7 — уникальные локальные, fe80::/10 — link-local.
    return /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
  }
  return false;
}

/**
 * Что делать с запросом, пришедшим на HTTP-сокет.
 *
 * Вынесено чистой функцией: это единственное место, где решается «пустить или отправить на
 * https», и ошибка здесь либо оставляет данные в открытом виде, либо делает кокпит недоступным.
 *
 * `remoteAddress` — адрес СОКЕТА, а не `request.ip`. Разница принципиальна: за шлюзом
 * `request.ip` — это адрес клиента из `X-Forwarded-For` (публичный), и по нему запросы шлюза
 * улетали бы в редирект на локальный https-адрес, до которого снаружи не достучаться.
 * Сосед же всегда `127.0.0.1` — туннель приходит на loopback.
 */
export function decideHttpRequest({ remoteAddress, routeUrl, httpsUp, upgrade = false }) {
  // https не поднялся (нет сертификата, битый файл, занятый порт) — работаем как раньше.
  // Иначе кокпит стал бы недоступен из сети, и чинить пришлось бы с консоли мозга.
  if (!httpsUp) return 'pass';
  if (isLoopbackAddress(remoteAddress)) return 'pass';
  if (PUBLIC_HTTP_ROUTES.has(routeUrl)) return 'pass';
  // `wss://` браузер сам не подставит, а открытый `ws://` в сети — это PTY-шелл открытым текстом.
  if (upgrade) return 'drop';
  return 'redirect';
}

/**
 * Адреса этой машины, годные для сертификата.
 *
 * Фильтр по ИМЕНИ интерфейса, а не по диапазону: docker-мосты живут в тех же приватных
 * диапазонах (на этой машине рядом с настоящим адресом видны `192.168.48.1` и `192.168.16.1`),
 * а поля «scope global» в Node нет.
 *
 * Туннели (VPN) отсекаются наравне с мостами: по адресу внутри туннеля планшет до мозга не
 * дойдёт, значит в сертификате такому адресу делать нечего. Имя ловится и префиксом, и
 * суффиксом — sing-box зовёт свой интерфейс `singbox_tun`, и его `172.18.0.1` показывался
 * в «Доступе» жёлтым «Адрес не в сертификате» при полностью правильном сертификате.
 */
const SKIP_IFACE = /^(docker|br-|veth|virbr|vmnet|tailscale|zt)|(^|[-_])(tun|tap|wg|utun)\d*$/;

/**
 * Второй пояс — маска. Имена туннелей бывают любыми (`nordlynx`, `proton0`), но сеть у них
 * точка-точка: в /30 и уже клиенту места нет, домашней сети такой маски не бывает.
 */
function isPointToPoint(item) {
  const fromCidr = Number(String(item.cidr || '').split('/')[1]);
  if (Number.isInteger(fromCidr)) return fromCidr >= 30;
  return item.netmask === '255.255.255.252'
    || item.netmask === '255.255.255.254'
    || item.netmask === '255.255.255.255';
}

export function localAddresses() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    if (SKIP_IFACE.test(iface)) continue;
    for (const item of list || []) {
      if (item.internal) continue;
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (isPointToPoint(item)) continue;
      out.push({ address: item.address, iface });
    }
  }
  return out;
}

/**
 * Проверка адресов из тела запроса. Они уходят в `subjectAltName` и в `-extfile` openssl,
 * поэтому валидируем allowlist-ом, а не «фильтрацией плохого»:
 *  - `1.2.3.4,DNS:evil.com` иначе даст лист, валидный для чужого домена под нашим корнем;
 *  - перевод строки в extfile позволяет дописать `basicConstraints=CA:TRUE` и получить второй CA;
 *  - конфиг openssl понимает ещё `$ENV::` и `.include`.
 * `net.isIP` пропускает только настоящий адрес, в SAN уходит его канонизированный вид.
 */
export function normalizeAddresses(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TlsInputError('Укажите хотя бы один адрес.');
  }
  if (input.length > MAX_ADDRESSES) {
    throw new TlsInputError(`Слишком много адресов (максимум ${MAX_ADDRESSES}).`);
  }
  const out = [];
  for (const raw of input) {
    const value = String(raw ?? '').trim();
    if (!net.isIP(value)) {
      throw new TlsInputError(`Это не IP-адрес: «${value}». Домашние имена не подходят — сертификат выписывается на адрес.`);
    }
    if (!isPrivateAddress(value)) {
      throw new TlsInputError(`Адрес ${value} не из локальной сети. Публичные адреса дома не нужны и почти наверняка опечатка.`);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function fingerprintOf(pem) {
  return new X509Certificate(pem).fingerprint256;
}

function certFacts(pem) {
  const cert = new X509Certificate(pem);
  const notAfter = new Date(cert.validTo);
  const san = String(cert.subjectAltName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    fingerprint: cert.fingerprint256,
    notAfter: notAfter.toISOString(),
    daysLeft: Math.floor((notAfter.getTime() - Date.now()) / 86400000),
    san,
  };
}

/** Адреса из SAN — без префиксов «IP Address:»/«DNS:», чтобы сравнивать с адресами машины. */
function sanAddresses(san) {
  return san
    .filter((s) => /^IP Address:/i.test(s))
    .map((s) => s.replace(/^IP Address:\s*/i, '').trim());
}

export class LocalTls {
  /**
   * @param {object} opts
   * @param {string} opts.dir каталог листа (`server/.state/tls`)
   * @param {string} opts.caDir каталог корня (вне репозитория)
   */
  constructor({ dir, caDir }) {
    this.dir = dir;
    this.caDir = caDir;
    this.keyPath = path.join(dir, 'key.pem');
    this.certPath = path.join(dir, 'cert.pem');
    this.statePath = path.join(dir, 'state.json');
    this.caKeyPath = path.join(caDir, 'ca.key');
    this.caCertPath = path.join(caDir, 'ca.crt');
    this._busy = false;
  }

  /**
   * Маркер состояния.
   *
   * Именно маркер, а не «есть файлы»: вариант «выключено = переименовать в *.disabled» отвергнут —
   * переименование двух файлов не атомарно, обрыв посередине давал бы «есть cert, нет key»,
   * то есть тихий старт по http (cookie без Secure) при UI, показывающем «включено».
   */
  readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return (raw && typeof raw === 'object') ? raw : null;
    } catch {
      return null;
    }
  }

  writeState(patch) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const next = { ...(this.readState() || {}), ...patch };
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
    return next;
  }

  /**
   * Пара для https-сокета — или причина, по которой её нет.
   *
   * Никаких исключений наружу: битый сертификат не должен ронять сервер. `readFileSync` ловит
   * только отсутствие файла; пустой или обрезанный PEM читается успешно и падает уже на создании
   * сервера — а это вечный крэш-луп под `Restart=always`, вызванный кнопкой в браузере.
   * Поэтому пара проверяется `createSecureContext` заранее: он ловит и мусор, и ключ не от
   * этого сертификата.
   */
  load() {
    const state = this.readState();
    if (!state?.enabled) return { ok: false, reason: 'disabled' };
    let key; let cert;
    try {
      key = fs.readFileSync(this.keyPath);
      cert = fs.readFileSync(this.certPath);
    } catch (err) {
      return { ok: false, reason: `не читается файл сертификата: ${err.message}` };
    }
    try {
      tls.createSecureContext({ key, cert });
    } catch (err) {
      return { ok: false, reason: `сертификат не годится: ${err.message}` };
    }
    return { ok: true, key, cert, fingerprint: fingerprintOf(cert) };
  }

  caInfo() {
    try {
      const pem = fs.readFileSync(this.caCertPath, 'utf8');
      return { exists: true, pem, ...certFacts(pem) };
    } catch {
      return { exists: false };
    }
  }

  leafInfo() {
    try {
      const pem = fs.readFileSync(this.certPath, 'utf8');
      return { exists: true, ...certFacts(pem) };
    } catch {
      return { exists: false };
    }
  }

  async opensslAvailable() {
    try {
      await exec('openssl', ['version']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Полная картина для UI. Отдельно «что лежит на диске» и «что слушает процесс прямо сейчас»:
   * иначе «файлы есть» читается как «работает», хотя сертификат вступает в силу только
   * после перезапуска.
   */
  async status(runtime = {}) {
    const state = this.readState();
    const ca = this.caInfo();
    const leaf = this.leafInfo();
    const addresses = localAddresses();
    const covered = leaf.exists ? sanAddresses(leaf.san) : [];
    const missing = addresses
      .map((a) => a.address)
      .filter((a) => !covered.includes(a));

    return {
      enabled: !!state?.enabled,
      source: runtime.source || 'none',
      https: {
        up: !!runtime.up,
        port: runtime.port || null,
        error: runtime.error || '',
        fingerprint: runtime.fingerprint || '',
      },
      httpPort: runtime.httpPort || null,
      // Перезапуск нужен, когда на диске лежит не то, что реально загружено. Сравниваем
      // отпечатки, а не наличие файлов: перевыпуск в те же пути тоже требует перезапуска.
      needsRestart: !!state?.enabled && leaf.exists
        ? (runtime.fingerprint || '') !== leaf.fingerprint
        : !!state?.enabled !== !!runtime.up,
      ca: ca.exists
        ? { exists: true, fingerprint: ca.fingerprint, notAfter: ca.notAfter, daysLeft: ca.daysLeft }
        : { exists: false },
      leaf: leaf.exists
        ? {
          exists: true,
          fingerprint: leaf.fingerprint,
          notAfter: leaf.notAfter,
          daysLeft: leaf.daysLeft,
          addresses: covered,
        }
        : { exists: false },
      addresses,
      missingAddresses: missing,
      openssl: await this.opensslAvailable(),
    };
  }

  /** Корень файлом — его ставят на устройства. Секрета в нём нет, это публичная часть. */
  caCertificate() {
    const ca = this.caInfo();
    if (!ca.exists) throw new TlsInputError('Корневой сертификат ещё не создан.');
    return { pem: ca.pem, fingerprint: ca.fingerprint };
  }

  async ensureCa() {
    if (fs.existsSync(this.caKeyPath) && fs.existsSync(this.caCertPath)) return false;
    fs.mkdirSync(this.caDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.caDir, 0o700);
    const tmpKey = path.join(this.caDir, '.ca.key.tmp');
    const tmpCert = path.join(this.caDir, '.ca.crt.tmp');
    try {
      await exec('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', tmpKey]);
      fs.chmodSync(tmpKey, 0o600);
      await exec('openssl', [
        'req', '-x509', '-new', '-key', tmpKey, '-sha256',
        '-days', String(CA_DAYS),
        '-subj', '/CN=Cockpit Local CA',
        '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-addext', 'subjectKeyIdentifier=hash',
        '-addext', `nameConstraints=${NAME_CONSTRAINTS}`,
        '-out', tmpCert,
      ]);
      fs.chmodSync(tmpCert, 0o644);
      fs.renameSync(tmpKey, this.caKeyPath);
      fs.renameSync(tmpCert, this.caCertPath);
      return true;
    } finally {
      for (const f of [tmpKey, tmpCert]) { try { fs.unlinkSync(f); } catch { /* уже переехал */ } }
    }
  }

  /**
   * Выпустить лист на указанные адреса (корень создаётся при первом вызове).
   *
   * Всё пишется во временный каталог и переносится только после проверки — оборванная
   * генерация не должна оставить сервер с половиной пары.
   */
  async generate({ addresses }) {
    if (this._busy) throw new TlsInputError('Генерация уже идёт.');
    const list = normalizeAddresses(addresses);
    if (!await this.opensslAvailable()) {
      throw new TlsInputError('На этой машине нет openssl — сертификат выпустить нечем.');
    }
    this._busy = true;
    let tmpDir = '';
    try {
      await this.ensureCa();
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir, 0o700);
      tmpDir = await fsp.mkdtemp(path.join(this.dir, '.tmp-'));
      const keyTmp = path.join(tmpDir, 'key.pem');
      const csrTmp = path.join(tmpDir, 'req.csr');
      const certTmp = path.join(tmpDir, 'cert.pem');
      const extTmp = path.join(tmpDir, 'ext.cnf');

      // localhost и 127.0.0.1 добавляем всегда: стоят копейки, а закрывают открытие
      // `https://localhost:8143` на самом мозге без перевыпуска.
      const san = [...list.map((ip) => `IP:${ip}`), 'IP:127.0.0.1', 'DNS:localhost'];
      const uniqueSan = [...new Set(san)].join(',');
      fs.writeFileSync(extTmp, [
        'basicConstraints=CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid,issuer',
        `subjectAltName=${uniqueSan}`,
        '',
      ].join('\n'), { mode: 0o600 });

      await exec('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyTmp]);
      fs.chmodSync(keyTmp, 0o600);
      await exec('openssl', ['req', '-new', '-key', keyTmp, '-subj', '/CN=Cockpit', '-out', csrTmp]);
      await exec('openssl', [
        'x509', '-req', '-in', csrTmp, '-sha256',
        '-CA', this.caCertPath, '-CAkey', this.caKeyPath,
        '-CAcreateserial', '-CAserial', path.join(tmpDir, 'ca.srl'),
        '-days', String(LEAF_DAYS),
        '-extfile', extTmp,
        '-out', certTmp,
      ]);

      // Проверяем ровно то, что положим на диск: битую пару лучше поймать здесь, чем на старте.
      const key = fs.readFileSync(keyTmp);
      const cert = fs.readFileSync(certTmp);
      tls.createSecureContext({ key, cert });
      fs.chmodSync(certTmp, 0o644);

      fs.renameSync(keyTmp, this.keyPath);
      fs.renameSync(certTmp, this.certPath);

      const facts = certFacts(cert.toString('utf8'));
      const ca = this.caInfo();
      // Маркер — последним: он и есть «включено».
      this.writeState({
        enabled: true,
        issuedAt: new Date().toISOString(),
        notAfter: facts.notAfter,
        san: facts.san,
        addresses: list,
        fingerprint: facts.fingerprint,
        caFingerprint: ca.fingerprint || '',
      });
      return { addresses: list, ...facts, caFingerprint: ca.fingerprint || '' };
    } finally {
      this._busy = false;
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Выключить. Приватный ключ листа удаляем: оставлять его «на всякий случай» — это вечный
   * приватный ключ в каталоге, который никто не перебирает. Корень остаётся: он стоит на
   * устройствах, а лист выпускается заново за секунду.
   */
  disable() {
    try { fs.unlinkSync(this.keyPath); } catch { /* уже нет */ }
    try { fs.unlinkSync(this.certPath); } catch { /* уже нет */ }
    return this.writeState({ enabled: false, disabledAt: new Date().toISOString() });
  }
}
