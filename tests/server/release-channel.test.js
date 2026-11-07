import assert from 'node:assert/strict';
import test from 'node:test';

import { ReleaseChannelService } from '../../server/src/lib/releaseChannel.ts';
import { signedIndex } from '../helpers/releaseV2Fixture.mjs';

/** Все transport-поведение проверяется на единственном формате — подписанном v1-индексе. */
function channelService(overrides, fetcher) {
  const fixture = signedIndex();

  return {
    fixture,
    service: new ReleaseChannelService({
      channel: 'release',
      publicKeyPem: fixture.publicKeyPem,
      ...overrides,
      fetch: fetcher(() => fixture),
    }),
  };
}

test('RCH-1: основной источник читается, конверт декодируется', async () => {
  const { fixture, service } = channelService({}, (feed) => {
    return async (url) => {
      if (String(url).includes('grigdesk.com')) {
        return new Response(JSON.stringify(fixture.index), { status: 200 });
      }

      return new Response('not here', { status: 404 });
    };
  });

  assert.equal((await service.latest())?.payload.version, fixture.index.latest.payload.version);
});

test('RCH-2: недоступный основной переключает на зеркало', async () => {
  const { fixture, service } = channelService({}, () => {
    return async (url) => {
      if (String(url).includes('grigdesk.com')) {
        throw new Error('down');
      }

      return new Response(JSON.stringify(fixture.index));
    };
  });

  assert.equal((await service.latest())?.payload.version, fixture.index.latest.payload.version);
});

test('RCH-3: все источники недоступны — ошибка, повтор не раньше cooldown', async () => {
  let calls = 0;
  const { service } = channelService({}, () => {
    return async () => {
      calls += 1;
      throw new Error('down');
    };
  });

  await assert.rejects(service.latest());
  await assert.rejects(service.latest());
  assert.equal(calls, 2);
});

test('RCH-4: redirect и мусор запрещены', async () => {
  const redirected = channelService({}, () => {
    return async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'https://x' }
      });
    };
  });

  await assert.rejects(redirected.service.latest());

  const broken = channelService({}, () => {
    return async () => {
      return new Response('{"format": 1}', { status: 200 });
    };
  });

  await assert.rejects(broken.service.latest());
});

test('RCH-5: параллельные чтения объединяются, fresh-кеш и cooldown ограничивают сеть', async () => {
  let calls = 0;
  let now = 1000;
  const { service } = channelService({ now: () => now }, (feed) => {
    return async () => {
      calls += 1;

      return new Response(JSON.stringify(feed().index));
    };
  });

  await Promise.all([service.latest(), service.latest()]);
  await service.latest();
  assert.equal(calls, 1);
  now += 5 * 60_000;
  await service.latest();
  assert.equal(calls, 2);
});

test('RCH-6: тело ограничено байтами, HTTP не передаётся fetch', async () => {
  const oversized = channelService({}, () => {
    return async () => {
      return new Response('я'.repeat(600_000));
    };
  });

  await assert.rejects(oversized.service.latest(), /лимит/);

  let calls = 0;
  const insecure = channelService({
    urls: ['http://site.example/release.json'],
  }, () => {
    return async () => {
      calls += 1;

      return new Response('{}');
    };
  });

  await assert.rejects(insecure.service.latest(), /HTTPS/);
  assert.equal(calls, 0);
});

for (const channel of ['release', 'dev']) {
  test(`CH-V1: фасад читает доверенный ${channel} без серверного процесса`, async () => {
    const fixture = signedIndex({ channel });
    const calls = [];
    const service = new ReleaseChannelService({
      channel,
      publicKeyPem: fixture.publicKeyPem,
      urls: [`https://grigdesk.test/api/releases/v1/${channel}.json`],
      fetch: async (url, options) => {
        calls.push({ url: String(url), options });

        return new Response(JSON.stringify(fixture.index));
      },
    });
    const latest = await service.latest(true);

    assert.deepEqual(latest, fixture.envelope);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, 'error');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
  });
}

const { compareProductVersions } = await import('../../shared/runtime/productReleaseVersion.ts');

for (const field of ['notes', 'serverApi']) {
  test(`TRUST-PARITY: изменение ${field} при прежней подписи отвергается ядром`, async () => {
    const fixture = signedIndex();
    const index = structuredClone(fixture.index);

    index.latest.payload[field] = field === 'notes'
      ? { ru: 'Поддельное описание', en: 'Forged notes' } : { major: 0, minor: 2 };

    const service = new ReleaseChannelService({
      channel: 'release',
      publicKeyPem: fixture.publicKeyPem,
      urls: ['https://grigdesk.test/release.json'],
      fetch: async () => new Response(JSON.stringify(index)),
    });

    await assert.rejects(service.latest(), /release_signature_invalid/);
  });
}

test('CH-ISOLATION: release не принимает dev, независимо от правильной подписи', async () => {
  const fixture = signedIndex({ channel: 'dev' });
  const service = new ReleaseChannelService({
    channel: 'release',
    publicKeyPem: fixture.publicKeyPem,
    urls: ['https://grigdesk.test/release.json'],
    fetch: async () => new Response(JSON.stringify(fixture.index)),
  });

  await assert.rejects(service.latest(), /release_channel_mismatch/);
});

test('CH-COMPARE: dev.9 < dev.10 < release; equal и older не новее', () => {
  for (const [left, right, expected] of [
    ['0.3.0-dev.9', '0.3.0-dev.10', -1],
    ['0.3.0-dev.10', '0.3.0', -1],
    ['0.3.0', '0.3.0', 0],
    ['0.2.0', '0.3.0-dev.10', -1],
    ['0.3.0', '0.3.0-dev.10', 1],
  ]) {
    assert.equal(compareProductVersions(left, right), expected);
  }
});

test('CH-OFFLINE: отказ не current, после cooldown разрешён повтор; null не ошибка', async () => {
  const fixture = signedIndex();
  let now = 1000;
  let online = false;
  const service = new ReleaseChannelService({
    channel: 'release',
    publicKeyPem: fixture.publicKeyPem,
    now: () => now,
    urls: ['https://grigdesk.test/release.json'],
    fetch: async () => {
      if (!online) {
        throw new Error('Синтетический timeout');
      }

      return new Response(JSON.stringify({ ...fixture.index, latest: null }));
    },
  });

  await assert.rejects(service.latest(), /timeout/);
  online = true;
  now += 30001;
  assert.equal(await service.latest(true), null);
});
