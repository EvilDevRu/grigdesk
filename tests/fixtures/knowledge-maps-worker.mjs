import { openKnowledgeStorage } from '../../server/src/lib/search/storage.ts';
import { createKnowledgeTransfer } from '../../server/src/lib/search/transfer.ts';

const [rootDir, dbPath] = process.argv.slice(2);
const storage = await openKnowledgeStorage({ dbPath, seedSamples: false, readOnly: true });
const snapshotRelease = Promise.withResolvers();
const transfer = createKnowledgeTransfer({
  rootDir,
  dbPath,
  knowledge: {
    async exportSnapshot() {
      const snapshot = await storage.exportSnapshot();
      process.send({ type: 'snapshot' });
      await snapshotRelease.promise;
      return snapshot;
    },
  },
});

process.on('message', async ({ type }) => {
  if (type === 'continue') {
    snapshotRelease.resolve();
  }
  if (type !== 'start') {
    return;
  }

  try {
    await transfer.updateMaps({ project: 'cockpit-test', sourceDocuments: ['alpha'] });
    process.send({ type: 'done' });
  } catch (error) {
    process.send({ type: 'failed', code: error.code, reasonCode: error.reasonCode });
    process.exitCode = 1;
  } finally {
    await storage.close();
    process.disconnect();
  }
});

process.send({ type: 'ready' });
