import assert from 'node:assert/strict';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { once } from 'node:events';
import test from 'node:test';

import { selfSignedCertificate } from '../../desktop/src/selfSignedCert.ts';

test('DC-01: сертификат подписан своим ключом, CN и P-256 сохранены', () => {
  const pair = selfSignedCertificate('Компьютер тест');
  const certificate = new X509Certificate(pair.cert);

  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(certificate.checkPrivateKey(createPrivateKey(pair.key)), true);
  assert.match(certificate.subject, /CN=Компьютер тест/);
  assert.equal(certificate.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.match(pair.key, /^-----BEGIN PRIVATE KEY-----/);
});

test('DC-02: срок сертификата составляет десять лет', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const certificate = new X509Certificate(selfSignedCertificate('Компьютер тест', now).cert);

  assert.equal(Date.parse(certificate.validFrom), now.getTime() - 60_000);
  assert.equal(Date.parse(certificate.validTo), now.getTime() + 3650 * 86_400_000);
});

test('DC-03: ключ и серийный номер каждого устройства новые', () => {
  const first = new X509Certificate(selfSignedCertificate('Компьютер тест').cert);
  const second = new X509Certificate(selfSignedCertificate('Компьютер тест').cert);

  assert.notEqual(first.fingerprint256, second.fingerprint256);
  assert.notEqual(first.serialNumber, second.serialNumber);
});

test('DC-04: устройство предъявляет сертификат через mTLS TLS 1.3', async (t) => {
  const pair = selfSignedCertificate('Компьютер тест');
  const serverPair = selfSignedCertificate('Сервер тест');
  const server = tls.createServer({
    ...serverPair,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });

  let client;
  let socket;

  t.after(async () => {
    client?.destroy();
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const accepted = once(server, 'secureConnection');

  client = tls.connect({
    ...pair,
    host: '127.0.0.1',
    port: server.address().port,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });

  [socket] = await accepted;

  assert.equal(socket.getPeerX509Certificate().fingerprint256, new X509Certificate(pair.cert).fingerprint256);
  assert.equal(socket.getProtocol(), 'TLSv1.3');
});
