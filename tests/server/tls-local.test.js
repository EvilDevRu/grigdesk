// Выпуск локального сертификата: параметры, права на файлы и защита входа.
//
// Адреса приезжают из тела HTTP-запроса и уходят в subjectAltName и в -extfile openssl,
// поэтому негативные кейсы здесь не формальность: инъекция в SAN даёт лист на чужой домен
// под корнем, которому доверяет планшет, а перевод строки в extfile — второй CA.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';

import { LocalTls, TlsInputError, localAddresses, normalizeAddresses } from '../../server/src/lib/tls/local.js';

async function tempTls(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-tls.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    tls: new LocalTls({ dir: path.join(root, 'state', 'tls'), caDir: path.join(root, 'ca') }),
  };
}

const mode = async (file) => (await stat(file)).mode & 0o777;

test('TLS-GEN-01: лист выписан на адрес, живёт не дольше года, цепочка сходится', async (t) => {
  const { tls } = await tempTls(t);
  const result = await tls.generate({ addresses: ['192.168.3.107'] });

  // Браузеры смотрят ТОЛЬКО subjectAltName, CN игнорируют; для адреса нужен именно IP-тип.
  assert.ok(result.san.includes('IP Address:192.168.3.107'));
  assert.ok(result.san.includes('IP Address:127.0.0.1'));
  assert.ok(result.san.includes('DNS:localhost'));
  // Лимит браузеров — 398 дней.
  assert.ok(result.daysLeft > 300 && result.daysLeft < 398, `daysLeft=${result.daysLeft}`);

  const leaf = new X509Certificate(await readFile(tls.certPath));
  const ca = new X509Certificate(await readFile(tls.caCertPath));
  assert.equal(leaf.checkIssued(ca), true, 'лист должен быть подписан нашим корнем');
  assert.equal(leaf.ca, false, 'лист не должен быть центром сертификации');
  assert.equal(ca.ca, true);

  // Приватные ключи — только владельцу; в каталоге с ключом корня посторонним делать нечего.
  assert.equal(await mode(tls.keyPath), 0o600);
  assert.equal(await mode(tls.caKeyPath), 0o600);
  assert.equal(await mode(tls.certPath), 0o644);
  assert.equal(await mode(tls.caDir), 0o700);

  // Пара грузится — именно она поедет в https-сокет.
  const loaded = tls.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fingerprint, result.fingerprint);
});

test('TLS-GEN-02: перевыпуск не трогает корень (устройства не переустанавливают)', async (t) => {
  const { tls } = await tempTls(t);
  const first = await tls.generate({ addresses: ['192.168.3.107'] });
  const caBefore = await readFile(tls.caCertPath, 'utf8');

  const second = await tls.generate({ addresses: ['10.8.0.5'] });
  const caAfter = await readFile(tls.caCertPath, 'utf8');

  assert.equal(caAfter, caBefore, 'корень обязан пережить перевыпуск листа');
  assert.equal(first.caFingerprint, second.caFingerprint);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.ok(second.san.includes('IP Address:10.8.0.5'));
});

test('TLS-GEN-03: мусор во входных адресах не доезжает до openssl', async (t) => {
  const { tls } = await tempTls(t);
  await tls.generate({ addresses: ['192.168.3.107'] });
  const good = await readFile(tls.certPath, 'utf8');

  const bad = [
    ['1.2.3.4,DNS:evil.com'],                      // инъекция в SAN
    ['1.2.3.4\nbasicConstraints=CA:TRUE'],         // инъекция в extfile → второй CA
    ['$ENV::HOME'],                                // конфиг openssl умеет и это
    ['; reboot'],
    ['8.8.8.8'],                                   // публичный адрес — дома не нужен
    ['cockpit.local'],                             // имя, а не адрес
    [],
    null,
    Array.from({ length: 9 }, (_, i) => `192.168.3.${i + 1}`),
  ];
  for (const addresses of bad) {
    await assert.rejects(
      () => tls.generate({ addresses }),
      (err) => err instanceof TlsInputError,
      `должно отвергаться: ${JSON.stringify(addresses)}`,
    );
  }
  assert.equal(await readFile(tls.certPath, 'utf8'), good, 'отказ не должен трогать выпущенный лист');

  // Дубликаты схлопываются, канонизированный вид — из net.isIP, а не исходная строка.
  assert.deepEqual(normalizeAddresses(['192.168.3.107', '192.168.3.107']), ['192.168.3.107']);
});

test('TLS-GEN-04: выключение не оставляет приватного ключа, но сохраняет корень', async (t) => {
  const { tls } = await tempTls(t);
  await tls.generate({ addresses: ['192.168.3.107'] });

  tls.disable();
  assert.equal(tls.readState().enabled, false);
  await assert.rejects(() => stat(tls.keyPath));
  assert.equal(tls.load().ok, false);
  // Корень остаётся: он уже стоит на устройствах, а лист выпускается заново за секунду.
  assert.ok((await stat(tls.caCertPath)).isFile());
});

test('TLS-GEN-05: битый сертификат не поднимает https, но и не роняет сервер', async (t) => {
  const { tls } = await tempTls(t);
  await tls.generate({ addresses: ['192.168.3.107'] });

  // Пустой файл читается успешно — падает уже создание сокета. Под Restart=always это
  // вечный крэш-луп, вызванный кнопкой в браузере, поэтому пара проверяется заранее.
  await writeFile(tls.certPath, '');
  assert.equal(tls.load().ok, false);

  await writeFile(tls.certPath, '-----BEGIN CERTIFICATE-----\nмусор\n-----END CERTIFICATE-----\n');
  assert.equal(tls.load().ok, false);

  // Ключ от другого сертификата — тоже не пара.
  const other = new LocalTls({ dir: path.join(tls.dir, 'other'), caDir: tls.caDir });
  await other.generate({ addresses: ['192.168.3.108'] });
  await writeFile(tls.certPath, await readFile(other.certPath));
  await writeFile(tls.keyPath, await readFile(tls.caKeyPath));
  assert.equal(tls.load().ok, false);
});

test('TLS-GEN-06: статус отделяет «лежит на диске» от «процесс слушает»', async (t) => {
  const { tls } = await tempTls(t);
  await tls.generate({ addresses: ['192.168.3.107'] });
  const leaf = tls.leafInfo();

  const cold = await tls.status({ source: 'none', up: false, port: 8143, httpPort: 8140 });
  assert.equal(cold.enabled, true);
  assert.equal(cold.https.up, false);
  assert.equal(cold.needsRestart, true, 'файлы есть, сокета нет — нужен перезапуск');

  const hot = await tls.status({
    source: 'state', up: true, port: 8143, httpPort: 8140, fingerprint: leaf.fingerprint,
  });
  assert.equal(hot.needsRestart, false);
  assert.equal(hot.leaf.addresses.includes('192.168.3.107'), true);

  // Перевыпуск в те же пути тоже требует перезапуска — сравниваем отпечатки, а не наличие файлов.
  await tls.generate({ addresses: ['192.168.3.107'] });
  const stale = await tls.status({
    source: 'state', up: true, port: 8143, httpPort: 8140, fingerprint: leaf.fingerprint,
  });
  assert.equal(stale.needsRestart, true);
});

test('TLS-GEN-07: туннель VPN не считается адресом машины (ложное «адрес не в сертификате»)', async (t) => {
  const { tls } = await tempTls(t);
  await tls.generate({ addresses: ['192.168.3.107'] });

  // Живая раскладка мозга: wi-fi, полтора десятка docker-мостов и TUN sing-box. Последний
  // не отсекался (имя `singbox_tun` — суффикс, а не префикс), и его 172.18.0.1 попадал в
  // «адреса машины»: раздел «Доступ» показывал жёлтое «Адрес не в сертификате» при
  // совершенно правильном сертификате.
  t.mock.method(os, 'networkInterfaces', () => ({
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }],
    wlp4s0: [{ address: '192.168.3.107', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.3.107/24' }],
    docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', internal: false, cidr: '172.17.0.1/16' }],
    'br-371461e6182a': [{ address: '192.168.16.1', netmask: '255.255.240.0', family: 'IPv4', internal: false, cidr: '192.168.16.1/20' }],
    singbox_tun: [{ address: '172.18.0.1', netmask: '255.255.255.252', family: 'IPv4', internal: false, cidr: '172.18.0.1/30' }],
    // Имя туннеля бывает любым — тогда его ловит маска точки-точки.
    nordlynx: [{ address: '10.5.0.2', netmask: '255.255.255.255', family: 'IPv4', internal: false, cidr: '10.5.0.2/32' }],
    wg0: [{ address: '10.8.0.3', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '10.8.0.3/24' }],
  }));

  assert.deepEqual(localAddresses().map((a) => a.address), ['192.168.3.107']);

  const status = await tls.status({ source: 'state', up: true, port: 8143, httpPort: 8140 });
  assert.deepEqual(status.missingAddresses, [], 'сертификат покрывает всё, что показываем человеку');
});
