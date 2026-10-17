import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicDownload } from '../../server/src/lib/studio3d/publicDownload.ts';

test('CDN запрещает схемы, credentials, private DNS и IPv6 без сетевого вызова', async () => {
  const addresses = ['127.0.0.1', '10.1.2.3', '169.254.169.254', '0:0:0:0:0:0:0:1', '::ffff:7f00:1'];
  let connected = 0;

  for (const address of addresses) {
    const fetchFile = createPublicDownload({
      lookupAll: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      connect: async () => {
        connected += 1;

        return new Response('недоступно');
      }
    });

    await assert.rejects(fetchFile('https://fixture.example/model.glb'), /unsafe_download_address/);
  }

  const fetchFile = createPublicDownload({ connect: async () => {
    connected += 1;

    return new Response('недоступно');
  } });

  for (const url of ['http://fixture.example/x', 'file:///tmp/x', 'https://a:b@fixture.example/x']) {
    await assert.rejects(fetchFile(url), /unsafe_download_url/);
  }

  assert.equal(connected, 0);
});

test('CDN закрепляет публичный адрес и удаляет Bearer/Cookie до connect', async () => {
  let lookups = 0;
  const fetchFile = createPublicDownload({
    lookupAll: async () => {
      lookups += 1;

      return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    },
    connect: async (_url, options, address) => {
      assert.equal(address.address, '8.8.8.8');
      assert.equal(new Headers(options.headers).has('authorization'), false);
      assert.equal(new Headers(options.headers).has('cookie'), false);

      return new Response('GLB');
    }
  });

  assert.equal(await (await fetchFile('https://fixture.example/x', {
    headers: { authorization: 'Bearer fixture-secret', cookie: 'fixture' }
  })).text(), 'GLB');
  assert.equal(lookups, 1);
});

test('CDN проверяет каждый redirect и не соединяется с новым private адресом', async () => {
  const connections = [];
  const fetchFile = createPublicDownload({
    lookupAll: async (host) => [{ address: host === 'fixture.example' ? '8.8.8.8' : '10.0.0.1', family: 4 }],
    connect: async (url) => {
      connections.push(url.host);

      return new Response(null, { status: 302, headers: { location: 'https://metadata.example/x' } });
    }
  });

  await assert.rejects(fetchFile('https://fixture.example/x'), /unsafe_download_address/);
  assert.deepEqual(connections, ['fixture.example']);
});

test('CDN разрешает публичный literal, но останавливает четвёртый redirect', async () => {
  let connections = 0;
  const fetchFile = createPublicDownload({ connect: async () => {
    connections += 1;

    return new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/x' } });
  } });

  await assert.rejects(fetchFile('https://8.8.8.8/x'), /unsafe_download_redirect/);
  assert.equal(connections, 4);
});
