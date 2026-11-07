import { browserAuthorityError } from './factoryBrowserBinding.ts';

import type { FactoryStateAdapter } from '../../adapters/factoryState.ts';
import type { RoutesStore } from '../../modules/routes/store.ts';

export interface TrustedBrowserAttempt {
  task: string;
  attempt: string;
  profile: string;
  catalogHash: string;
  route: string;
  routeHash: string;
  node: string;
  runKey: string;
  sequence: number;
  headEventHash: string;
  identity: string;
}

/**
 * Browser policy выводится из exact current cursor и content-addressed pinned route.
 * Provider-writable registry сверяется штатным ledger reader и не становится authority.
 */
export function createFactoryBrowserTrusted(options: {
  state: Pick<FactoryStateAdapter, 'readRegistry' | 'readTrustedAttempt'>;
  routes: Pick<RoutesStore, 'readCatalog' | 'readRoute'>;
  projectExists(profile: string): Promise<boolean>;
}) {
  return async (task: string): Promise<TrustedBrowserAttempt> => {
    try {
      const { registry } = await options.state.readRegistry(task);
      const trusted = await options.state.readTrustedAttempt(task, registry);
      const profile = trusted.profile;
      const catalogHash = trusted.catalogHash;
      const routeId = trusted.route;
      const routeHash = trusted.routeHash;
      const cursor = trusted.cursor;
      const visit = trusted.stageIdentity;

      if (trusted.task !== task || trusted.terminal !== null || !profile || !catalogHash
        || !routeId || !routeHash || cursor?.state !== 'ready' || !cursor.node || !visit
        || !await options.projectExists(profile)) {
        return browserAuthorityError();
      }

      const catalog = await options.routes.readCatalog(profile, catalogHash);

      if (catalog.catalog.routes[routeId] !== routeHash) {
        return browserAuthorityError();
      }

      const stored = await options.routes.readRoute(profile, routeId, routeHash);
      const node = stored.route.nodes.find((item) => item.id === cursor.node);

      if (!node || node.executor !== 'agent' || !node.runKey || node.policy?.browser !== 'allow') {
        return browserAuthorityError();
      }

      const value = {
        task,
        attempt: trusted.attempt,
        profile,
        catalogHash,
        route: routeId,
        routeHash,
        node: node.id,
        runKey: node.runKey,
        sequence: visit.sequence,
        headEventHash: visit.headEventHash,
      };

      return { ...value, identity: JSON.stringify(value) };
    } catch {
      return browserAuthorityError();
    }
  };
}
