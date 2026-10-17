import path from 'node:path';

import { runCommand } from '../../../server/src/lib/pluginInstall/runCommand.ts';
import { writeDurableFile } from '../../../server/src/lib/durableFile.ts';
import { commandTree } from '../helpers/pluginCommandTree.js';

const root = process.argv[2];
let worker = null;
let pending = '';

await runCommand(process.execPath, ['-e', commandTree(path.join(root, 'writer'))], {
  env: {},
  timeoutMs: 30000,
  ownership: {
    async started(value) {
      worker = value;
      await writeDurableFile(path.join(root, 'workers.json'), JSON.stringify(worker));
    },
    async finished() {},
  },
  onStderr(chunk) {
    pending += chunk;

    if (pending.includes('\n')) {
      process.send?.({
        type: 'ready',
        worker,
        descendants: JSON.parse(pending.trim()),
      });
    }
  },
});
