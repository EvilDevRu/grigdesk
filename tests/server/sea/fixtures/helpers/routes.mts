import { createRequire } from 'node:module';
import path from 'node:path';

import routesApi from '../../../../../server/src/modules/routes/api.ts';

const require = createRequire(new URL('../../../../../server/package.json', import.meta.url));
const Fastify = require('fastify');

/**
 * Выполняет validate/publish через настоящий HTTP-модуль на временном профиле.
 * Запуск самого helper-а другим Node отличает вложенный интерпретатор от execPath.
 */
export async function main(args: string[]): Promise<void> {
  const root = args[0]!;
  const app = Fastify();

  app.register(routesApi, { baseDir: path.join(root, 'routes'), profilesDir: path.join(root, 'profiles') });

  try {
    const responses = [];

    for (const mode of ['validate', 'publish']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/routes/fixture/publish',
        payload: { mode, expectedCatalogHash: null },
      });

      responses.push({ status: response.statusCode, body: response.json() });
    }

    console.log(JSON.stringify(responses));
  } finally {
    await app.close();
  }
}
