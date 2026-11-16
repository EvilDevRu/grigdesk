import { getAsset, isSea } from 'node:sea';
import manifest from '../package.json' with { type: 'json' };
import { B24Error } from './errors.ts';
import { runPipeline } from './pipelineApp.ts';
import { createProcessIO } from './processIO.ts';

const controller = new AbortController();
/**
 * Отмена завершает только клиентский процесс и его текущий stdin/запрос.
 * Серверная операция после подтверждения продолжает жить самостоятельно.
 */
function cancel(): void {
    controller.abort(new B24Error(130, 'Команда pipeline отменена.'));
}

process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);
void runPipeline(process.argv.slice(2), {
    version: manifest.version,
    license: () => isSea()
        ? getAsset('NODE-LICENSE', 'utf8') : 'Лицензия установленного Node.js.\n',
}, createProcessIO({
    maxStdinBytes: 262144,
    signal: controller.signal,
})).then((code) => {
    process.exitCode = code;
}, () => {
    process.exitCode = 1;
}).finally(() => {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
});
