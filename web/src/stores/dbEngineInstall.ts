import { createPackageInstallStore } from './packageInstall.ts';
import { loadDb } from '../actions/db/loadDb.ts';

export const useDbEngineInstallStore = createPackageInstallStore({
  storeId: 'db-engine-install',
  basePath: '/api/db/engine-installs',
  itemSegment: 'engines',
  rollbackKey: 'grigdesk-db-engine-install-rollback',
  viewedKey: 'grigdesk-db-engine-install-viewed',
  refresh: () => loadDb(),
});
