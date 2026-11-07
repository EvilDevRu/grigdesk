import path from 'node:path';
import { parseArgs } from 'node:util';

import { kit } from './routes-kit.mjs';
import { profile } from './common.mjs';
import { definitions, bootstrap, bootstrapPrompts, catalogFor } from './definition.mjs';

/**
 * Проверяет все маршруты до записи; публикация требует явного каталога и CAS.
 * Перечитывание подтверждает immutable hashes, live store не выбирается по умолчанию.
 */
async function publish() {
  const { values } = parseArgs({ options: {
    validate: { type: 'boolean' },
    publish: { type: 'boolean' },
    'base-dir': { type: 'string' },
    'expected-catalog-hash': { type: 'string' },
  } });

  for (const [id, definition] of Object.entries(definitions)) {
    kit.validateRoute(definition.route, {
      profile,
      routeId: id,
      promptFiles: kit.validatePromptFiles(definition.prompts, { prefix: 'prompts/' }),
    });
  }

  kit.validateBootstrap(bootstrap, {
    profile,
    promptFiles: kit.validatePromptFiles(bootstrapPrompts, { prefix: 'bootstrap/prompts/' }),
  });
  kit.validateCatalog(catalogFor(Object.fromEntries(Object.keys(definitions)
    .map((id) => [id, 'a'.repeat(64)]))), { profile });

  if (values.validate && !values.publish) {
    process.stdout.write('Определения маршрутов проверены\n');

    return;
  }

  if (!values.publish || !path.isAbsolute(values['base-dir'] || '')
      || !Object.hasOwn(values, 'expected-catalog-hash')) {
    throw new Error('Нужны --publish --base-dir ABS --expected-catalog-hash null|SHA256');
  }

  const expected = values['expected-catalog-hash'];

  if (expected !== 'null' && !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('Неверный expected catalog hash');
  }

  const store = new kit.RoutesStore({ baseDir: values['base-dir'] });
  const current = await store.readCurrent(profile);
  const expectedHash = expected === 'null' ? null : expected;

  if ((current?.catalogHash ?? null) !== expectedHash) {
    throw new Error('Current catalog изменился; перечитайте expected catalog hash');
  }

  const hashes = {};

  for (const [id, definition] of Object.entries(definitions)) {
    const result = await store.publishRoute(profile, id, definition);

    hashes[id] = result.routeHash;
    await store.readRoute(profile, id, result.routeHash);
  }

  const result = await store.publishCatalog(profile, {
    catalog: catalogFor(hashes),
    bootstrap,
    prompts: bootstrapPrompts,
  }, { expectedCatalogHash: expectedHash });

  await store.readCatalog(profile, result.catalogHash);

  const published = {
    profile,
    ...result,
    routes: hashes,
  };

  process.stdout.write(`${JSON.stringify(published)}\n`);
}

await publish();
