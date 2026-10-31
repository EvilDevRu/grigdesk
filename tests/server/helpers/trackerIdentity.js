import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { copyCustomPackage } from './trackerCustomPackage.js';
import { trackerFixture } from './trackerFixture.js';

/**
 * Identity вычисляет настоящий клиент драйвера, сетевой ответ задаётся на границе raw.
 * Смена credentials идёт через runtime с тем же registry и host, что у HTTP-приложения.
 */
export async function identityFixture(t, onDiscovery) {
  const fixture = await trackerFixture(t, {
    legacy: true,
    setup: async (config) => {
      await copyCustomPackage(config);
    },
  });

  // Registry импортирует временную копию пакета, подменяется prototype именно этой копии.
  // Клиент остаётся настоящим: кеш discoverUserId и смена session проверяются без стабов identity.
  const copiedClient = await import(pathToFileURL(
    path.join(fixture.config.driversDir, 'b24-custom/src/client.ts'),
  ).href);

  // Прежний identity-double отдавал URL с завершающим слешем, нормализация URL здесь не проверяется.
  // Сохраняем этот входной атрибут сессии, не подменяя discoverUserId и его настоящий кеш.
  t.mock.method(copiedClient.B24Client.prototype, 'ensureAuth', async function () {
    this.baseUrl = 'https://portal.example.test/';
  });
  t.mock.method(copiedClient.B24Client.prototype, 'raw', async () => {
    onDiscovery();

    return { text: async () => 'USER_ID=77;' };
  });
  await fixture.runtime.writeSettings('b24-custom', {
    'b24-custom': {
      baseUrl: 'https://portal.example.test/',
      login: 'user',
      password: 'secret',
    },
  });

  return {
    adapter: fixture.b24,
    changeCredentials: () => fixture.runtime.writeSettings('b24-custom', {
      'b24-custom': { password: 'changed-secret' },
    }),
  };
}
