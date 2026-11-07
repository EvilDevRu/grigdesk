import { readFile } from 'node:fs/promises';

import { PluginInstallService } from '../../../server/src/lib/packageInstall/service.ts';

const control = JSON.parse(process.argv[2]);
let service;

service = new PluginInstallService({
  ...control.options,
  runNpm: async (cwd, signal, workspaceBudget) => service.run(process.execPath, ['-e',
    "process.stderr.write('HELD\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], {
    cwd,
    signal,
    workspaceBudget,
    timeoutMs: 60_000,
    onStderr: async (chunk) => {
      if (chunk.includes('HELD')) {
        const state = JSON.parse(await readFile(control.options.statePath, 'utf8'));

        process.send({
          type: 'held',
          jobId: state.job.id,
          workers: state.workers,
        });
      }
    },
  }),
});
await service.recover();
service.bindRuntime({
  isLoaded: () => false,
  prepareReplace: async () => ({ finish: async () => {} }),
  refresh: async () => {},
});
await service.startInstall({ url: control.url });
await service.whenIdle();
await service.close();
process.disconnect();
