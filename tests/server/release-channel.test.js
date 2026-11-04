import assert from 'node:assert/strict';
import test from 'node:test';

import { ReleaseChannelService } from '../../server/src/lib/releaseChannel.ts';

const entry = (version) => {
  return ({
  version,
    commit: 'a'.repeat(40),
    archiveSha256: 'b'.repeat(64),
    archiveSize: 10,
  bundleSha256: 'c'.repeat(64),
    signature: Buffer.alloc(64, 1).toString('base64'),
  archiveUrl: `https://grigdesk.com/releases/${version}/release.tar.gz`,
  compat: {
    os: 'linux',
    arch: 'x64',
    glibc: '2.28'
  },
});
};

test('RCH-1: основной источник читается, запись декодируется', async () => {
  const service = new ReleaseChannelService({
    fetch: async (url) => {
      if (String(url).includes('grigdesk.com')) {
        return new Response(JSON.stringify({
          format: 1,
          latest: entry('0.3.0'),
          publishedAt: '2026-11-02T00:00:00.000Z'
        }), { status: 200 });
      }

      return new Response('not here', { status: 404 });
    },
  });

  assert.equal((await service.latest())?.version, '0.3.0');
});

test('RCH-2: недоступный основной переключает на зеркало', async () => {
  const service = new ReleaseChannelService({
    fetch: async (url) => {
      if (String(url).includes('grigdesk.com')) {
        throw new Error('down');
      }

      return new Response(JSON.stringify({
        format: 1,
        latest: entry('0.4.0'),
        publishedAt: '2026-11-02T00:00:00.000Z'
      }), { status: 200 });
    },
  });

  assert.equal((await service.latest())?.version, '0.4.0');
});

test('RCH-3: все источники недоступны — ошибка, повтор не раньше cooldown', async () => {
  let calls = 0;
  const service = new ReleaseChannelService({
    fetch: async () => {
      calls += 1;
      throw new Error('down');
    },
  });

  await assert.rejects(service.latest());
  await assert.rejects(service.latest());
  assert.equal(calls, 2);
});

test('RCH-4: redirect и мусор запрещены', async () => {
  const redirected = new ReleaseChannelService({
    fetch: async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'https://x' }
      });
    },
  });

  await assert.rejects(redirected.latest());

  const broken = new ReleaseChannelService({
    fetch: async () => {
      return new Response('{"format": 2}', { status: 200 });
    },
  });

  await assert.rejects(broken.latest());
});

test('RCH-5: параллельные чтения объединяются, fresh-кеш и cooldown ограничивают сеть', async () => {
  let calls = 0;
  let now = 1000;
  const service = new ReleaseChannelService({
    now: () => {
      return now;
    },
    fetch: async () => {
      calls += 1;

      return new Response(JSON.stringify({
        format: 1,
        latest: entry('0.3.0'),
        publishedAt: '2026-11-02T00:00:00.000Z',
      }));
    },
  });

  await Promise.all([service.latest(), service.latest()]);
  await service.latest();
  assert.equal(calls, 1);
  now += 5 * 60_000;
  await service.latest();
  assert.equal(calls, 2);
});

test('RCH-6: тело ограничено байтами, HTTP не передаётся fetch', async () => {
  const oversized = new ReleaseChannelService({
    fetch: async () => {
      return new Response('я'.repeat(600_000));
    },
  });

  await assert.rejects(oversized.latest(), /лимит/);

  let calls = 0;
  const insecure = new ReleaseChannelService({
    urls: ['http://site.example/channel.json'],
    fetch: async () => {
      calls += 1;

      return new Response('{}');
    },
  });

  await assert.rejects(insecure.latest(), /HTTPS/);
  assert.equal(calls, 0);
});
