import type { PrefsStore } from '../prefsStore.ts';
import type { FactoryBrowserAuthority } from './factoryBrowserIdentity.ts';

import { createBrowserAccess } from './browserAccess.ts';
import { createBrowserBroker } from './browserBroker.ts';
import { createBrowserEvidence } from './browserEvidence.ts';
import { factoryBrowserOwner } from './factoryBrowserIdentity.ts';
import { browserRelaySocket } from './factoryBrowserRuntime.ts';
import { createBrowserOwners } from './browserOwners.ts';
import { createBrowserRouting } from './browserRouting.ts';
import { startBrowserSocket } from './browserSocket.ts';
import { prepareBrowserSocket } from './browserSocketDirectory.ts';

/**
 * HTTP host, чат и engine socket используют один broker и один grant ledger.
 * Browser mode переживает рестарт; отсутствие окна не включает другой transport.
 */
export async function createBrowserService(options: {
  prefs: PrefsStore;
  dataHome: string;
  artifactsDir: string;
  authority: FactoryBrowserAuthority;
}) {
  const owners = createBrowserOwners();
  const routing = createBrowserRouting(options.prefs);
  const broker = createBrowserBroker({ validateOwner: (owner) => owners.exists(owner) });
  const access = createBrowserAccess({
    generation: broker.generation,
    exists: async (owner) => routing.mode() === 'grigdesk' && await owners.exists(owner),
    queue: (owner, input, value) => broker.invoke(owner, input, value.signal, value.authorize,
      { grantEpoch: value.grantEpoch }),
  });
  const file = browserRelaySocket(options.dataHome);

  await prepareBrowserSocket(file);

  const evidence = createBrowserEvidence(options.artifactsDir);
  const socket = await startBrowserSocket({
    file,
    owner: async (proof) => {
      const owner = await factoryBrowserOwner(options.authority, proof);

      return JSON.stringify([owner.kind, owner.projectId, owner.key, owner.attemptId]);
    },
    probe: async (proof) => ({
      mode: routing.mode(),
      available: broker.available(),
      evidenceRoot: await evidence.prepare(proof),
    }),
    invoke: (owner, input, signal, authorize) => access.invoke(owner, input, { signal, authorize }),
    evidence,
  });

  return {
    owners,
    routing,
    broker,
    access,
    async close() {
      access.clear();
      broker.close();
      await socket.close();
    },
  };
}

export type BrowserService = Awaited<ReturnType<typeof createBrowserService>>;
