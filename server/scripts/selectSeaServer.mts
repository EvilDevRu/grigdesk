import { isDirectRun } from '../src/lib/helperEntry.ts';
import { selectSeaServer } from '../src/lib/selectSeaServer.ts';

/**
 * CLI выбора проверяет точную форму до любых файловых эффектов.
 * Обработка ошибки не запускает окно и не отправляет команды живому серверу.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 1 || !argv[0] || argv[0].startsWith('-')) {
    process.stderr.write('Использование: grigdesk-ctl desktop use-server <R>\n');

    return 2;
  }

  try {
    const selected = await selectSeaServer({ root: argv[0] });

    process.stdout.write(`Выбран сервер GrigDesk: ${selected}\n`);

    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);

    return 1;
  }
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
