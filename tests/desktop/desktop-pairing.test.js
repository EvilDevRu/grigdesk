import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { clientFixture } from '../server/helpers/clientAccess.js';
import { temporary } from '../relay/helpers.js';
import { sealedIdentity } from '../../desktop/src/identity.ts';
import { createPairing } from '../../desktop/src/pairing.ts';
import { Profiles } from '../../desktop/src/profiles.ts';
import { normalizeSettings } from '../../desktop/src/settings.ts';
import { encodePairing } from '../../shared/client/pairingPayload.ts';

/**
 * Настоящий TLS-вход получает код, а desktop хранит ключ через синтетический sealer.
 * Ни один файл проверки не относится к установленному приложению человека.
 */
async function pairingFixture(t, available = true) {
  const fixture = await clientFixture(t, {
    register({ app, identity }) {
      app.get('/api/client/hello', async () => ({ name: 'Машина в тесте', fp: identity.fp }));
    },
  });
  const directory = await temporary(t);
  const identity = sealedIdentity({
    available: () => available,
    seal: (text) => Buffer.from(`sealed:${text}`),
    open: (data) => data.toString().slice(7),
  });
  const settings = normalizeSettings(null);
  const profiles = new Profiles({
    settings,
    save: async () => {},
    available: async () => true,
  });
  const pairing = createPairing({
    profiles,
    identity,
    directory: path.join(directory, 'identity'),
  });
  const issued = fixture.pairing.issue({ scope: 'client', name: 'Окно в тесте' });
  const payload = {
    host: '127.0.0.1',
    port: fixture.port,
    fp: fixture.identity.fp,
    code: issued.code,
  };

  return {
    fixture,
    directory,
    identity,
    settings,
    pairing,
    payload,
  };
}

test('привязка создаёт профиль с именем hello, повтор использует личность и профиль', async (t) => {
  const { pairing, settings, payload, fixture } = await pairingFixture(t);
  const first = await pairing.addByPairing(encodePairing(payload));
  const second = await pairing.addByPairing(encodePairing(payload));

  assert.equal(first.name, 'Машина в тесте');
  assert.equal(second.id, first.id);
  assert.equal(settings.profiles.length, 1);
  assert.equal((await fixture.devices.list()).length, 1);
});

test('чужой pin не отправляет pair, недоступная связка не пишет открытый ключ', async (t) => {
  const good = await pairingFixture(t);

  await assert.rejects(good.pairing.addByPairing(encodePairing({ ...good.payload, fp: '00'.repeat(32) })),
    /Это не тот сервер/);
  assert.equal((await good.fixture.devices.list()).length, 0);
  assert.equal(good.settings.profiles.length, 0);

  const unavailable = await pairingFixture(t, false);

  await assert.rejects(unavailable.pairing.addByPairing(encodePairing(unavailable.payload)),
    /Защищённое хранилище ключей недоступно/);
  assert.deepEqual(await readdir(unavailable.directory), []);
});

test('W3: отказ сети объясняется по-русски без адреса и системного кода', async (t) => {
  const { freePort } = await import('../server/helpers/pluginBootFixture.js');
  const { pairing, payload } = await pairingFixture(t);

  const unavailable = encodePairing({ ...payload, port: await freePort() });

  await assert.rejects(pairing.addByPairing(unavailable), (error) => {
    assert.match(error.message, /Доступ к серверу/);
    assert.doesNotMatch(error.message, /GRIGDESK_CLIENT_LISTEN/);
    assert.doesNotMatch(error.message, /127\.0\.0\.1|ECONNREFUSED|ENOTFOUND/);

    return true;
  });
});
