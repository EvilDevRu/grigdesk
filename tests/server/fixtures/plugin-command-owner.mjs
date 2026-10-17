import { runCommand } from '../../../server/src/lib/pluginInstall/runCommand.ts';

const result = await runCommand(process.execPath, ['-e', `
  process.stderr.write('start');
  setInterval(() => {}, 100);
`], {
  env: {},
  timeoutMs: 3000,
  onStderr() {
    throw new Error('fixture-secret');
  },
});

process.send?.({ type: 'result', result });
process.disconnect?.();
