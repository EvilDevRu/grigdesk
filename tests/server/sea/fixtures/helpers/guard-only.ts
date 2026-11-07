// Фикстура «только guard»: CLI при прямом запуске есть, экспортируемого main нет.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write('guard-only\n');
}
