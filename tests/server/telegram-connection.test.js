import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramConnection } from '../../server/src/lib/telegram/connection.js';

const tokenA = '8123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi';
const tokenB = '9123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi';

function memoryCredentials(events = []) {
  let saved = null;
  let nextWriteError = null;
  return {
    read: async () => (saved ? structuredClone(saved) : null),
    write: async (value) => {
      events.push(`credentials:${value.botId}`);
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = null;
        throw error;
      }
      saved = { schemaVersion: 1, channel: 'telegram', ...structuredClone(value), updatedAtMs: 2 };
      return structuredClone(saved);
    },
    clear: async () => { const existed = saved !== null; saved = null; return existed; },
    publicView: async () => saved ? {
      configured: true,
      botId: saved.botId,
      tokenHint: `…${saved.token.slice(-4)}`,
      connectedAtMs: saved.connectedAtMs,
    } : { configured: false, botId: null, tokenHint: '', connectedAtMs: null },
    seed: (value) => { saved = structuredClone(value); },
    failNextWrite: (error) => { nextWriteError = error; },
  };
}

function memoryBindings(events = []) {
  const rows = [];
  let selectedAccountRef = null;
  return {
    async read() {
      return {
        schemaVersion: 1, channel: 'telegram', selectedAccountRef,
        updatedAtMs: rows.length ? 1 : null, bindings: structuredClone(rows),
      };
    },
    async selected() {
      return structuredClone(rows.find((row) => row.accountRef === selectedAccountRef) || null);
    },
    async byAccountRef(accountRef) {
      return structuredClone(rows.find((row) => row.accountRef === accountRef) || null);
    },
    async select(accountRef) {
      const binding = rows.find((row) => row.accountRef === accountRef);
      if (!binding) throw new Error('unknown binding');
      events.push(`select:${accountRef}`);
      selectedAccountRef = accountRef;
      return structuredClone(binding);
    },
    async resolveOrCreate(identity, { select = true } = {}) {
      events.push(`resolve:${identity[3]}:${select}`);
      let binding = rows.find((row) => JSON.stringify(row.providerIdentity) === JSON.stringify(identity));
      const created = !binding;
      if (!binding) {
        binding = {
          accountRef: `acc_bot_${identity[3]}`,
          providerIdentity: [...identity],
          createdAtMs: 1,
        };
        rows.push(binding);
      }
      if (select) selectedAccountRef = binding.accountRef;
      return { created, selected: select, binding: structuredClone(binding) };
    },
  };
}

function contexts(events = []) {
  const owners = new Map();
  let nextSetBotError = null;
  const factory = async ({ accountRef, botId, credentialLease }) => {
    let owner = owners.get(accountRef);
    if (!owner) {
      const settings = {
        botId: Number(botId), username: '', canReadAllGroupMessages: null,
        connectedAtMs: null, serviceChatId: null,
      };
      const activation = { participation: 'never_activated', activationVersion: 0 };
      owner = {
        settings,
        activation,
        deactivations: [],
        make(credential) {
          return {
            botId,
            credentials: credential,
            archive: { append: async () => {}, head: async () => ({ seq: 0, occurredAt: 0 }) },
            rules: { read: async () => [] },
            pollState: { read: async () => null, write: async () => {} },
            botSettings: {
              read: async () => structuredClone(settings),
              setBot: async (next) => {
                events.push(`settings:${botId}`);
                if (nextSetBotError) {
                  const error = nextSetBotError;
                  nextSetBotError = null;
                  throw error;
                }
                return Object.assign(settings, next);
              },
              setServiceChatId: async (id) => { settings.serviceChatId = id; },
            },
            inboxState: {
              summary: async () => ({ ...activation }),
              deactivate: async ({ expectedActivationVersion, endReason, createActivationMarker }) => {
                assert.equal(expectedActivationVersion, activation.activationVersion);
                const marker = await createActivationMarker({ nowMs: 10 });
                activation.participation = 'deactivated';
                activation.activationVersion += 1;
                owner.deactivations.push({ endReason, marker });
                return { ...activation };
              },
            },
            createActivationMarker: async ({ nowMs }) => ({ schema: 1, afterSeq: 0, afterOccurredAt: nowMs }),
          };
        },
      };
      owners.set(accountRef, owner);
    }
    return owner.make(credentialLease);
  };
  return {
    owners,
    factory,
    failNextSetBot(error) { nextSetBotError = error; },
  };
}

function fixture() {
  const events = [];
  const credentials = memoryCredentials(events);
  const bindings = memoryBindings(events);
  const accountContexts = contexts(events);
  const pollEvents = [];
  const poller = {
    start: () => { pollEvents.push('start'); events.push('poller:start'); },
    stop: async () => { pollEvents.push('stop'); events.push('poller:stop'); },
  };
  const getMeCalls = [];
  const botApi = {
    getMe: async (token) => {
      getMeCalls.push(token);
      events.push(`getMe:${token.slice(0, token.indexOf(':'))}`);
      return {
        id: Number(token.slice(0, token.indexOf(':'))),
        username: token === tokenA ? 'bot_a' : 'bot_b',
        canReadAllGroupMessages: token === tokenA,
      };
    },
  };
  const options = {
    credentials,
    bindings,
    accountContextFor: accountContexts.factory,
    poller,
    botApi,
    now: () => 1_800_000_000_000,
    log: { warn() {}, error() {} },
  };
  const connection = new TelegramConnection(options);
  return {
    connection, credentials, bindings, accountContexts, pollEvents, getMeCalls, events,
    restart: (overrides = {}) => new TelegramConnection({ ...options, poller: null, ...overrides }),
  };
}

test('первый connect проверяет getMe, создаёт owner и публикует safe status', async () => {
  const f = fixture();
  await f.connection.initialize();
  f.events.length = 0;
  const drain = f.connection.runtime.drain.bind(f.connection.runtime);
  const install = f.connection.runtime.install.bind(f.connection.runtime);
  f.connection.runtime.drain = async (options) => {
    f.events.push('runtime:drain');
    return drain(options);
  };
  f.connection.runtime.install = async (options) => {
    f.events.push('runtime:install');
    return install(options);
  };
  const status = await f.connection.connect({ token: tokenA });
  assert.equal(status.connection, 'connected');
  assert.equal(status.bot.username, 'bot_a');
  assert.equal(status.bot.botId, 8123456789);
  assert.equal(status.bot.tokenHint, '…fghi');
  assert.equal(JSON.stringify(status).includes(tokenA), false);
  assert.deepEqual(f.getMeCalls, [tokenA]);
  assert.deepEqual(f.pollEvents, ['stop', 'start']);
  assert.deepEqual(f.events, [
    'getMe:8123456789',
    'resolve:8123456789:false',
    'settings:8123456789',
    'poller:stop',
    'runtime:drain',
    'select:acc_bot_8123456789',
    'credentials:8123456789',
    'runtime:install',
    'poller:start',
  ]);
  const selected = await f.bindings.selected();
  assert.deepEqual(selected.providerIdentity, [1, 'api.telegram.org', 'bot', '8123456789']);
  const lease = f.connection.acquireLease();
  assert.equal(lease.accountRef, selected.accountRef);
  assert.equal(lease.context.credentials.token, tokenA);
  lease.release();
});

test('disconnect ждёт poller, закрывает epoch, стирает token и сохраняет offline namespace', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  const selected = await f.bindings.selected();
  const owner = f.accountContexts.owners.get(selected.accountRef);
  owner.activation.participation = 'active';
  owner.activation.activationVersion = 4;

  const status = await f.connection.disconnect();
  assert.equal(status.connection, 'disconnected');
  assert.equal(status.bot.configured, false);
  assert.equal(await f.credentials.read(), null);
  assert.deepEqual(f.pollEvents, ['stop', 'start', 'stop']);
  assert.deepEqual(owner.deactivations, [{
    endReason: 'provider_disconnect',
    marker: { schema: 1, afterSeq: 0, afterOccurredAt: 10 },
  }]);
  const lease = f.connection.acquireLease();
  assert.equal(lease.accountRef, selected.accountRef);
  assert.equal(lease.context.credentials, null);
  assert.equal(lease.context.botSettings !== null, true);
  lease.release();
});

test('reconnect того же bot возвращает прежний namespace без auto-activation', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  const first = await f.bindings.selected();
  const owner = f.accountContexts.owners.get(first.accountRef);
  owner.activation.participation = 'active';
  owner.activation.activationVersion = 1;
  await f.connection.disconnect();
  await f.connection.connect({ token: tokenA });
  const second = await f.bindings.selected();
  assert.equal(second.accountRef, first.accountRef);
  assert.equal(owner.activation.participation, 'deactivated');
});

test('новый bot после disconnect получает другой accountRef и пустой namespace', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  const first = await f.bindings.selected();
  await f.connection.disconnect();
  await f.connection.connect({ token: tokenB });
  const second = await f.bindings.selected();
  assert.notEqual(second.accountRef, first.accountRef);
  assert.equal(f.accountContexts.owners.size, 2);
});

test('recheck не принимает сменившуюся provider identity', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  f.connection.botApi.getMe = async () => ({
    id: 9123456789, username: 'other', canReadAllGroupMessages: true,
  });
  await assert.rejects(
    f.connection.recheck(),
    (error) => error.code === 'telegram_account_changed',
  );
  assert.equal((await f.credentials.read()).botId, '8123456789');
});

test('ошибка owner metadata не публикует selected нового bot', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  await f.connection.disconnect();
  const old = await f.bindings.selected();
  const injected = Object.assign(new Error('settings failed'), { code: 'settings_failed' });
  f.accountContexts.failNextSetBot(injected);

  await assert.rejects(
    f.connection.connect({ token: tokenB }),
    (error) => error === injected,
  );
  assert.equal((await f.bindings.selected()).accountRef, old.accountRef);
  assert.equal(await f.credentials.read(), null);
  const lease = f.connection.acquireLease();
  assert.equal(lease.accountRef, old.accountRef);
  assert.equal(lease.isCurrent(), true);
  lease.release();
});

test('ошибка credential после select оставляет restartable offline owner, не старый runtime', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  await f.connection.disconnect();
  const old = await f.bindings.selected();
  const injected = Object.assign(new Error('credential failed'), { code: 'credential_failed' });
  f.credentials.failNextWrite(injected);

  await assert.rejects(
    f.connection.connect({ token: tokenB }),
    (error) => error === injected,
  );
  const selected = await f.bindings.selected();
  assert.notEqual(selected.accountRef, old.accountRef);
  assert.equal(await f.credentials.read(), null);
  const recoveredLease = f.connection.acquireLease();
  assert.equal(recoveredLease.accountRef, selected.accountRef);
  assert.equal(recoveredLease.context.credentials, null);
  recoveredLease.release();

  const restarted = f.restart();
  const status = await restarted.initialize();
  assert.equal(status.connection, 'disconnected');
  assert.equal(status.reason, null);
  const restartLease = restarted.acquireLease();
  assert.equal(restartLease.accountRef, selected.accountRef);
  assert.equal(restartLease.context.credentials, null);
  restartLease.release();
});

test('crash-window после durable credential восстанавливается connected на restart', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  await f.connection.disconnect();
  const injected = Object.assign(new Error('install failed'), { code: 'install_failed' });
  f.connection.runtime.install = async () => { throw injected; };

  await assert.rejects(
    f.connection.connect({ token: tokenB }),
    (error) => error === injected,
  );
  const selected = await f.bindings.selected();
  const saved = await f.credentials.read();
  assert.equal(saved.accountRef, selected.accountRef);
  assert.equal(saved.botId, '9123456789');
  assert.notEqual(f.pollEvents.at(-1), 'start', 'failed install не запускает poller');

  const restarted = f.restart();
  const status = await restarted.initialize();
  assert.equal(status.connection, 'connected');
  assert.equal(status.reason, null);
  const lease = restarted.acquireLease();
  assert.equal(lease.accountRef, selected.accountRef);
  assert.equal(lease.context.credentials.token, tokenB);
  lease.release();
});

test('account switch сначала останавливает poller и drain-ит старые leases', async () => {
  const f = fixture();
  await f.connection.initialize();
  await f.connection.connect({ token: tokenA });
  await f.connection.disconnect();
  const old = await f.bindings.selected();
  const oldLease = f.connection.acquireLease();
  let settled = false;
  const switching = f.connection.connect({ token: tokenB }).then(
    (value) => { settled = true; return value; },
    (error) => { settled = true; throw error; },
  );

  for (let attempt = 0; attempt < 20 && oldLease.isCurrent(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(oldLease.isCurrent(), false, 'old generation должна перейти в draining');
  assert.equal(settled, false, 'switch ждёт release старой account-scoped операции');
  assert.equal((await f.bindings.selected()).accountRef, old.accountRef, 'pointer ещё не опубликован');
  assert.equal(f.pollEvents.at(-1), 'stop');
  assert.throws(
    () => f.connection.acquireLease(),
    (error) => error.code === 'account_draining',
  );

  oldLease.release();
  const status = await switching;
  assert.equal(status.connection, 'connected');
  const selected = await f.bindings.selected();
  assert.notEqual(selected.accountRef, old.accountRef);
  const newLease = f.connection.acquireLease();
  assert.equal(newLease.accountRef, selected.accountRef);
  assert.equal(newLease.context.credentials.token, tokenB);
  newLease.release();
  assert.equal(f.pollEvents.at(-1), 'start', 'poller запускается только после new runtime install');
});
