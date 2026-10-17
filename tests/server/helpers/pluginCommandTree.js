/**
 * Внук подтверждает установку обработчика TERM через IPC до наблюдения parent.
 * Его stdout остаётся открытым, а marker доказывает настоящий работающий writer.
 */
export function commandTree(marker, naturalExit = false) {
  const grandchild = `
    process.on('SIGTERM', () => {});
    setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 10);
    process.send({ ready: true });
  `;

  return `
    const args = [${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}];
    const child = require('node:child_process').fork('-e', args, {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.once('message', () => {
      process.stderr.write(JSON.stringify([process.pid, child.pid]) + '\\n', () => {
        if (${naturalExit}) {
          process.exit(0);
        }
      });
    });
    setInterval(() => {}, 100);
  `;
}
