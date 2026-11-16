import assert from 'node:assert/strict';

import { copyCustomPackage } from './trackerPackage.js';
import { trackerFixture } from './trackerFixture.js';

/**
 * Identity и кеш определяет настоящий пакет через host.fetch.
 * Транспорт разрешает только discovery; реквизиты меняются штатным runtime.
 */
export async function identityFixture(t, onDiscovery) {
  let measuring = false;
  const fixture = await trackerFixture(t, {
    setup: copyCustomPackage,
    fetch: async (url) => {
      assert.equal(String(url), 'https://portal.example.test/api/v1/auth/token');

      if (measuring) {
        onDiscovery();
      }

      return new Response(JSON.stringify({ data: { user: { id: 77 } } }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  if (!fixture) {
    return null;
  }

  await fixture.runtime.writeSettings('grigdesk-b24-discript', {
    'grigdesk-b24-discript': {
      baseUrl: 'https://portal.example.test/',
      accessToken: 'fixture-token',
    },
  });

  measuring = true;

  // Подготовленный API-пакет принимает boolean fresh вместо объекта read-options.
  // Registry оставляет реальный lease и credentials, не принуждая discovery на каждом чтении.
  return {
    adapter: {
      accountIdentity: () => fixture.runtime.registry.call('grigdesk-b24-discript',
        (tracker) => tracker.accountIdentity()),
    },
    async changeCredentials() {
      measuring = false;
      await fixture.runtime.writeSettings('grigdesk-b24-discript', {
        'grigdesk-b24-discript': { accessToken: 'changed-token' },
      });
      measuring = true;
    },
  };
}
