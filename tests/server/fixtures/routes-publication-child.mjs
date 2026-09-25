import { readFileSync } from 'node:fs';

import { DraftStore } from '../../../server/src/modules/routes/draftStore.ts';
import { RoutesPublicationCoordinator } from '../../../server/src/modules/routes/publicationCoordinator.ts';
import { RoutesStore } from '../../../server/src/modules/routes/store.ts';

const [configurationFile, stage] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configurationFile, 'utf8'));
const store = new RoutesStore({ baseDir: config.routesDir });
const drafts = new DraftStore({ baseDir: config.authoringDir, routesStore: store });
const coordinator = new RoutesPublicationCoordinator(store, drafts, config.profilesDir);

async function barrier(name) {
  process.send?.({ type: 'barrier', stage: name });
  await new Promise(() => {});
}

const hooks = {
  afterIntent: stage === 'afterIntent' ? () => barrier('afterIntent') : undefined,
  afterActivation: stage === 'afterActivation' ? () => barrier('afterActivation') : undefined,
  afterReceipt: stage === 'afterReceipt' ? () => barrier('afterReceipt') : undefined,
};

try {
  await coordinator.publish(config.profile, config.input, hooks);
  process.send?.({ type: 'unexpected-completion' });
} catch (error) {
  process.send?.({ type: 'error', code: error.code ?? 'unknown', message: error.message });
}
