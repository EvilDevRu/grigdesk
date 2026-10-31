// Первые bytes blob читаются без checkout и без shell pipeline.
// Весь остальной поток дренируется, чтобы Git завершил свою группу перед outcome.
import { spawn } from 'node:child_process';

const sha = process.argv[2];

if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha ?? '')) {
  process.exit(1);
}

const child = spawn('/usr/bin/git', [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0',
  'cat-file', 'blob', sha,
], {
  env: process.env,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let remaining = 1024;

child.stdout.on('data', (chunk) => {
  if (remaining > 0) {
    const prefix = chunk.subarray(0, remaining);

    remaining -= prefix.length;
    process.stdout.write(prefix);
  }
});
child.stderr.pipe(process.stderr);
child.once('error', () => {
  process.exitCode = 127;
});
child.once('close', (code) => {
  process.exitCode = code ?? 1;
});
