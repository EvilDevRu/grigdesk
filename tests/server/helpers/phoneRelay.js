import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { readConfig } from '../../../relay/src/config.ts';
import { createRelayServer } from '../../../relay/src/relayServer.ts';
import { connect, hello } from '../../relay/helpers.js';
import { freePort } from './pluginBootFixture.js';
import { legacyRelay } from './legacyRelay.js';
/**
 * Собственные credentials берутся из RelayStore выбранного сервера, как в рабочем сценарии.
 * Внешний relay использует эти же сертификат и токены; служебные файлы человека не читаются.
 */
export async function configuredRelay(t, fixture, options = {}) {
  const port = await freePort();
  const record = await fixture.mobile.relays.add({
    name: 'Ретранслятор лаборатории',
    host: fixture.host,
    port
  });
  const directory = path.join(fixture.directory, 'relays', record.id);
  const key = await readFile(path.join(directory, 'relay-key.pem'), 'utf8');
  const cert = await readFile(path.join(directory, 'relay-cert.pem'), 'utf8');
  const { createHash } = await import('node:crypto');
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const relay = options.legacy ? legacyRelay({
    key,
    cert,
    brainToken: record.brainToken,
    deviceToken: record.deviceToken,
  }) : createRelayServer({
    ...readConfig({
      RELAY_TLS_KEY_B64: Buffer.from(key).toString('base64'),
      RELAY_TLS_CERT_B64: Buffer.from(cert).toString('base64'),
      RELAY_BRAIN_TOKEN_SHA256: digest(record.brainToken),
      RELAY_DEVICE_TOKEN_SHA256: digest(record.deviceToken),
    }),
    port,
  }, { log: () => { } });

  await relay.listen('0.0.0.0', port);
  t.after(() => relay.close());
  await fixture.mobile.start();

  const deadline = Date.now() + 5000;
  let state;

  do {
    const status = await fixture.mobile.status();

    state = status.relays.find((item) => item.id === record.id)?.link.state;

    if (state === 'online') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  assert.equal(state, 'online', 'Синтетический server→relay control должен быть подключён');

  return { ...record, relay };
}
/**
 * Пин relay проверяется до hello с token, затем пин сервера до HTTP с кодом привязки.
 * Настоящий двойной TLS нужен и relay-only сценарию, и проверке отозванного сертификата.
 */
export async function relayRequest(f, relay, url, body, client = f.client, version = 2) {
  const outer = await connect(relay.port, relay.fp);

  try {
    const ack = await hello(outer, {
      v: version,
      role: 'device',
      token: relay.deviceToken,
      ...(version === 2 ? { target: 'client' } : {}),
    });

    assert.equal(ack.ok, true, `Внешний слой relay: ${JSON.stringify(ack)}`);

    const inner = tls.connect({
      socket: outer,
      key: client?.keyPem,
      cert: client?.certPem,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });

    await new Promise((resolve, reject) => {
      inner.once('secureConnect', resolve);
      inner.once('error', reject);
    });

    const actualPin = inner.getPeerX509Certificate().fingerprint256.replaceAll(':', '').toLowerCase();

    assert.equal(actualPin, f.identity.fp);

    const agent = new https.Agent({ maxCachedSessions: 0 });

    agent.createConnection = () => inner;

    try {
      return await new Promise((resolve, reject) => {
        const request = https.request({
          hostname: '127.0.0.1',
          port: relay.port,
          path: url,
          method: body === undefined ? 'GET' : 'POST',
          agent,
          headers: body === undefined ? {} : {
            'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
          },
        }, (response) => {
          let text = '';

          response.on('data', (bytes) => {
            text += bytes;
          });
          response.on('end', () => resolve({
            status: response.statusCode,
            text,
            body: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null,
          }));
          response.on('error', reject);
        });

        request.setTimeout(5000, () => request.destroy(new Error('fixture_http_timeout')));
        request.on('error', reject);
        request.end(body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body));
      });
    }
    finally {
      agent.destroy();
    }
  }
  finally {
    outer.destroy();
  }
}
