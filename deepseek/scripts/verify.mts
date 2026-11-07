import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const binary = args.length === 2 && args[0] === '--binary' ? path.resolve(args[1]!) : null;

if (args.length > 0 && !binary) {
  process.stderr.write('Использование: npm --prefix deepseek run verify -- [--binary <ELF>]\n');
  process.exitCode = 2;
} else {
  const child = spawn(binary ?? path.join(root, 'bin/deepseek'), ['--verify', '--json'], {
    stdio: 'inherit',
  });

  child.once('error', () => {
    process.stderr.write('Не удалось запустить проверку DeepSeek binary\n');
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    process.exitCode = code ?? 1;
  });
}
