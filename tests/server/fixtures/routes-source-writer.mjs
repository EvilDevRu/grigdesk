import { readFileSync } from 'node:fs';

import { RoutesStore } from '../../../server/src/modules/routes/store.ts';

const [routesDir, inputFile, expectedCatalogHash] = process.argv.slice(2);
const store = new RoutesStore({ baseDir: routesDir });
const input = JSON.parse(readFileSync(inputFile, 'utf8'));
try {
  await store.publishCatalog('sample', input, { expectedCatalogHash });
  process.stdout.write(JSON.stringify({ code: 'ok' }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code ?? 'unknown' }));
}
