import { RoutesStore } from '../../../server/src/modules/routes/store.ts';

const [routesDir, desiredHash, expectedHash] = process.argv.slice(2);
const store = new RoutesStore({ baseDir: routesDir });
const result = await store.compareAndSwapCurrent('sample', desiredHash, {
  expectedCatalogHash: expectedHash === 'null' ? null : expectedHash,
});
process.stdout.write(JSON.stringify(result));
