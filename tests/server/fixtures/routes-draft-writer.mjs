import { DraftStore } from '../../../server/src/modules/routes/draftStore.ts';
import { RoutesStore } from '../../../server/src/modules/routes/store.ts';

const [baseDir, routesDir, profile, id, title] = process.argv.slice(2);
const routesStore = new RoutesStore({ baseDir: routesDir });
const store = new DraftStore({ baseDir, routesStore });

try {
  const snapshot = await store.read(profile, id);
  process.send?.({ type: 'ready', revision: snapshot.revision });

  process.on('message', async (message) => {
    if (message?.type !== 'go') {
      return;
    }

    try {
      const result = await store.patch(profile, id, {
        expectedRevision: snapshot.revision,
        operations: [{ kind: 'setTitle', title }],
      });
      process.send?.({ type: 'result', state: 'success', revision: result.revision, title });
    } catch (error) {
      process.send?.({
        type: 'result',
        state: 'error',
        code: error.code,
        currentRevision: error.details?.currentRevision ?? null,
      });
    }
    process.disconnect?.();
  });
} catch (error) {
  process.send?.({ type: 'result', state: 'error', code: error.code ?? 'startup_failed' });
  process.disconnect?.();
}
