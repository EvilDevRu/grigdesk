import { createPackageInstallStore } from './packageInstall.ts';
import { usePluginsStore } from './plugins.ts';

export const usePluginInstallStore = createPackageInstallStore({
  storeId: 'plugin-install',
  basePath: '/api/plugin-installs',
  itemSegment: 'plugins',
  rollbackKey: 'grigdesk-plugin-install-rollback',
  viewedKey: 'grigdesk-plugin-install-viewed',
  refresh: () => usePluginsStore().load(),
});
