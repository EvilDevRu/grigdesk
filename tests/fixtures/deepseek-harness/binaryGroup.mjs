import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const [directory, role, mode] = process.argv.slice(2);

if (role === 'worker' || role === 'sentinel') {
  const marker = path.join(directory, `${role}.marker`);
  const timer = setInterval(() => appendFileSync(marker, 'x'), 20);

  process.on('SIGTERM', () => {
    if (mode !== 'blocked') {
      clearInterval(timer);
      process.exit(0);
    }
  });
  writeFileSync(path.join(directory, `${role}.pid`), String(process.pid));
} else {
  const worker = spawn(process.execPath, [import.meta.filename, directory, 'worker', mode], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  process.on('SIGTERM', () => {
    if (mode !== 'blocked') {
      worker.kill('SIGTERM');
      worker.once('exit', () => process.exit(0));
    }
  });
}
