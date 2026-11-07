import { pathToFileURL } from 'node:url';

const entry = process.argv[2]!;

process.argv = [process.argv[0]!, ...process.argv.slice(2)];

/**
 * Disconnect наблюдается до импорта Harness и запуска его управляемых команд.
 * При смерти launcher worker получает штатный SIGTERM даже во время загрузки.
 */
function requestStop(): void {
  process.kill(process.pid, 'SIGTERM');
}

process.once('disconnect', requestStop);

if (!process.connected) {
  process.exit(0);
}

const profile = process.argv.indexOf('--profile');

if (profile >= 0 && process.argv[profile + 1] === 'acp') {
  process.stdin.once('end', requestStop);
}

await import(pathToFileURL(entry).href);
process.channel?.unref();
