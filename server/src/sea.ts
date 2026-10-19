// SEA-вход сервера: сначала служебные команды, только для запуска — app.ts.
// Импорт этого файла не читает .env и не создаёт папку данных.
import { runSeaCli } from './lib/seaCli.ts';

void runSeaCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`GrigDesk: ${message}\n`);
  process.exitCode = 1;
});
