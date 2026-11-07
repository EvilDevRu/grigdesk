import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { readConfig } from '../../relay/src/config.ts';
import { createRelayServer } from '../../relay/src/relayServer.ts';
import { connect, hello, makeCert, readLine, relayEnv, temporary } from './helpers.js';
/**
 * Один настоящий relay связывает независимые v1/client пары через единственный control.
 * Закрытие каждого созданного сокета зарегистрировано до первого protocol hello.
 */
async function fixture(t, capabilities) {
  const cert = await makeCert(await temporary(t), 'relay');
  const relay = createRelayServer({ ...readConfig(relayEnv({ cert })), port: 0 }, { log: () => { } });
  const port = await relay.listen('127.0.0.1');

  t.after(() => relay.close());

  const dial = async () => {
    const socket = await connect(port, cert.fp);

    t.after(() => socket.destroy());

    return socket;
  };
  const control = await dial();
  const ack = await hello(control, {
    v: 1,
    role: 'brain-control',
    token: 'brain-token',
    ...(capabilities ? { capabilities } : {}),
  });

  return {
    control,
    ack,
    dial
  };
}
/**
 * Pending id и target берутся из настоящего incoming control, не выдумываются тестом.
 * ACK обоих концов вычитывается до проверки двустороннего бинарного потока.
 */
async function pair(f, v) {
  const incoming = readLine(f.control);
  const device = await f.dial();
  const deviceAck = hello(device, {
    v,
    role: 'device',
    token: 'device-token',
    ...(v === 2 ? { target: 'client' } : {}),
  });
  const notice = JSON.parse(await incoming);
  const brain = await f.dial();
  const ack = await hello(brain, {
    v,
    role: 'brain-data',
    token: 'brain-token',
    id: notice.id,
    ...(v === 2 ? { target: 'client' } : {}),
  });

  assert.equal(ack.ok, true);
  assert.equal((await deviceAck).ok, true);

  if (v === 2) {
    assert.equal(notice.target, 'client');
  }

  return { device, brain };
}
/**
 * Отдельное чтение сохраняет бинарные байты после ACK без декодирования в JSON.
 * Потоки остаются открыты, чтобы проверить одновременность старой и новой пары.
 */
async function transfer(from, to, bytes) {
  const receiving = once(to, 'data');

  to.resume();
  from.write(bytes);
  assert.deepEqual((await receiving)[0], bytes);
  to.pause();
}

test('PHONE-05: один control одновременно обслуживает v1/client', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, ['client-v2']);

  assert.equal(f.ack.ok, true);
  assert.ok(f.ack.capabilities?.includes('client-v2'), 'relay должен подтвердить capability');

  const legacy = await pair(f, 1);
  const client = await pair(f, 2);

  await transfer(legacy.device, legacy.brain, Buffer.from([0, 255, 17]));
  await transfer(client.device, client.brain, Buffer.from([22, 3, 3, 0, 1]));
  await transfer(legacy.brain, legacy.device, Buffer.from('v1 всё ещё работает'));
  await transfer(client.brain, client.device, Buffer.from('новый client'));
  assert.equal(f.control.destroyed, false);
});
test('PHONE-05: старый control сохраняет wire и не получает client-v2', async (t) => {
  const f = await fixture(t);

  assert.deepEqual(f.ack, { ok: true });

  const legacy = await pair(f, 1);

  await transfer(legacy.device, legacy.brain, Buffer.from('legacy'));

  const client = await f.dial();
  const denied = await hello(client, {
    v: 2,
    target: 'client',
    role: 'device',
    token: 'device-token'
  });

  assert.equal(denied.ok, false);
  assert.equal(f.control.destroyed, false);
});
test('PHONE-05: target data обязан совпадать с pending', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, ['client-v2']);

  assert.ok(f.ack.capabilities?.includes('client-v2'));

  const incoming = readLine(f.control);
  const device = await f.dial();
  const waiting = hello(device, {
    v: 2,
    target: 'client',
    role: 'device',
    token: 'device-token'
  });
  const notice = JSON.parse(await incoming);
  const wrong = await f.dial();

  assert.equal((await hello(wrong, {
    v: 1,
    role: 'brain-data',
    token: 'brain-token',
    id: notice.id,
  })).ok, false);

  const correct = await f.dial();

  assert.equal((await hello(correct, {
    v: 2,
    target: 'client',
    role: 'brain-data',
    token: 'brain-token',
    id: notice.id,
  })).ok, true);
  assert.equal((await waiting).ok, true);
});
