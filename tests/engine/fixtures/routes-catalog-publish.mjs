import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bootstrap,
  bootstrapPrompts,
  catalogForRoutes,
  PROFILE_ID,
  ROUTE_DEFINITIONS,
  ROUTE_IDS,
} from './routes-catalog-definitions.mjs';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const { RoutesStore } = await import(
  path.resolve(fixtureDir, '../../../server/src/modules/routes/store.js')
);

const [baseDir, expected = 'null'] = process.argv.slice(2);
if (!baseDir) throw new Error('baseDir обязателен');
if (!path.isAbsolute(baseDir)) throw new Error('baseDir должен быть абсолютным');

const expectedCatalogHash = expected === 'null' ? null : expected;
if (
  expectedCatalogHash !== null
  && !/^[a-f0-9]{64}$/.test(expectedCatalogHash)
) {
  throw new Error('expected должен быть null или sha256 в нижнем регистре');
}

const store = new RoutesStore({ baseDir });
const routeHashes = {};
for (const routeId of ROUTE_IDS) {
  const published = await store.publishRoute(
    PROFILE_ID,
    routeId,
    ROUTE_DEFINITIONS[routeId],
  );
  routeHashes[routeId] = published.routeHash;
}

const publishedCatalog = await store.publishCatalog(PROFILE_ID, {
  catalog: catalogForRoutes(routeHashes),
  bootstrap,
  prompts: bootstrapPrompts,
}, {
  expectedCatalogHash,
});

process.stdout.write(`${JSON.stringify({
  profile: PROFILE_ID,
  routeHashes,
  catalogHash: publishedCatalog.catalogHash,
})}\n`);
