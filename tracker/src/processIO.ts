import os from 'node:os';
import { readTextOrNull } from '../../shared/node/files.ts';
import type { AppIO } from './app.ts';
import { B24Error } from './errors.ts';
import { request } from './http.ts';
/**
 * Собирает адаптер процесса для двух CLI без запуска команд при импорте.
 * Ограничение stdin применяется только при явном maxStdinBytes.
 */
export function createProcessIO(options: {
    maxStdinBytes?: number;
    signal?: AbortSignal;
} = {}): AppIO & {
    signal?: AbortSignal;
} {
    return {
        env: process.env,
        signal: options.signal,
        getHome: () => os.homedir(),
        readText: readTextOrNull,
        request,
        /**
         * Читает байты до EOF и ограничивает размер только для pipeline.
         * Отмена освобождает stdin и снимает свой обработчик сигнала.
         */
        async readStdin() {
            const chunks: Buffer[] = [];
            let size = 0;
            const cancel = () => process.stdin.destroy(new B24Error(130, 'Команда pipeline отменена.'));

            options.signal?.throwIfAborted();
            options.signal?.addEventListener('abort', cancel, {
                once: true
            });

            try {
                for await (const chunk of process.stdin) {
                    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

                    size += bytes.length;

                    if (options.maxStdinBytes !== undefined && size > options.maxStdinBytes) {
                        throw new B24Error(2, 'JSON из stdin превышает 256 КиБ.');
                    }

                    chunks.push(bytes);
                }

                return Buffer.concat(chunks);
            }
            finally {
                options.signal?.removeEventListener('abort', cancel);
            }
        },
        writeStdout: (value) => writeTo(process.stdout, value),
        writeStderr: (value) => writeTo(process.stderr, value),
    };
}
/**
 * Ждёт callback потока, чтобы EPIPE и ошибки записи обрабатывались приложением.
 * Общий адаптер не устанавливает обработчики событий при импорте.
 */
function writeTo(stream: NodeJS.WriteStream, value: string | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        stream.write(value, (error) => {
            if (error) {
                reject(error);
            }
            else {
                resolve();
            }
        });
    });
}
