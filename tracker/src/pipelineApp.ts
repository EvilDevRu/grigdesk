import { WAIT_COMMANDS } from './pipelineWait.ts';
import { ARBITER_COMMANDS } from './pipelineArbiter.ts';
import { PRELUDE_COMMANDS } from './pipelinePrelude.ts';
import { SETTINGS_COMMANDS } from './pipelineSettings.ts';
import { CONTROL_COMMANDS } from './pipelineControl.ts';
import { isTaskSourceId } from '../../shared/tasks/taskReference.ts';
import { LAUNCH_COMMANDS } from './pipelineLaunch.ts';
import { READ_COMMANDS } from './pipelineReads.ts';
import type { AppIO, RuntimeInfo } from './app.ts';
import { B24Error } from './errors.ts';
import { resolveConnection } from './config.ts';
import type { Connection } from './config.ts';

export interface PipelineIO extends AppIO {
    signal?: AbortSignal;
  now?(): number;
  sleep?(milliseconds: number, signal?: AbortSignal): Promise<void>;
  armDeadline?(milliseconds: number): { signal: AbortSignal; dispose(): void };
}
export interface PipelineContext {
    connection: Connection;
    io: PipelineIO;
}
export interface PipelineSpec {
    params: readonly string[];
    defaults?: Readonly<Record<string, string>>;
    method: 'GET' | 'POST';
    path(values: Record<string, string>): string;
    body?(value: unknown, values: Record<string, string>): Record<string, unknown>;
    format?(value: unknown, values: Record<string, string>): unknown;
    text?: boolean;
    run?(values: Record<string, string>, context: PipelineContext): Promise<PipelineResult>;
}
export interface PipelineResult {
    output: unknown;
    code?: number;
}

const COMMANDS: Record<string, PipelineSpec> = {
    ...READ_COMMANDS,
    ...LAUNCH_COMMANDS,
    ...CONTROL_COMMANDS,
    ...PRELUDE_COMMANDS,
    ...SETTINGS_COMMANDS,
    ...ARBITER_COMMANDS,
    ...WAIT_COMMANDS,
};
const PATTERNS: Record<string, RegExp> = {
    task: /^[1-9][0-9]{0,18}$/u,
    profile: /^[a-z0-9][a-z0-9_-]{0,63}$/u,
    attempt: /^a_[a-f0-9]{32}$/u,
    node: /^[a-z0-9][a-z0-9_-]{0,40}$/u,
    stage: /^[A-Z][A-Z0-9_]{0,63}$/u,
    key: /^[A-Z][A-Z0-9_]{0,63}$/u,
    conversation: /^c_[a-f0-9]{32}$/u,
    provider: /^[a-z][a-z0-9_-]{0,63}$/u,
    board: /^[a-z0-9][a-z0-9_-]{0,127}$/u,
    afterSequence: /^(0|[1-9][0-9]{0,8})$/u,
    knownRevision: /^(0|[1-9][0-9]{0,8})$/u,
    timeoutMs: /^[1-9][0-9]{0,7}$/u,
    intervalMs: /^[1-9][0-9]{0,5}$/u,
    decision: /^(approve|reject)$/u,
    doc: /^(plan|recon|diag|ship|report|audit|review)$/u,
};
/**
 * Разбирает только именованные параметры опубликованной команды.
 * Опечатка в идентификаторе не нормализуется до другого объекта.
 */
function argumentsOf(spec: PipelineSpec, args: readonly string[]): Record<string, string> {
    const minimum = spec.params.filter((name) => spec.defaults?.[name] === undefined).length;

    if (args.length < minimum || args.length > spec.params.length) {
        throw new B24Error(2, 'Неверное число аргументов команды pipeline.');
    }

    const values = Object.fromEntries(spec.params.map((name, index) => [
        name, args[index] ?? spec.defaults?.[name] ?? '',
    ]));

    for (const [name, value] of Object.entries(values)) {
        if (PATTERNS[name] && !PATTERNS[name].test(value)) {
            throw new B24Error(2, 'Некорректный параметр pipeline: ' + name + '.');
        }
    }

    if ((values.timeoutMs !== undefined && Number(values.timeoutMs) > 86400000)
        || (values.intervalMs !== undefined && Number(values.intervalMs) > 60000)) {
        throw new B24Error(2, 'Слишком большой срок или интервал wait.');
    }

    if (values.source !== undefined && !isTaskSourceId(values.source)) {
        throw new B24Error(2, 'Укажите полный подтверждённый source.');
    }

    return values;
}
/**
 * Требует цельный JSON-объект; повреждённое тело не доходит до HTTP.
 * Максимум байтов дополнительно ограничен адаптером stdin процесса.
 */
async function inputObject(io: PipelineIO): Promise<unknown> {
    try {
        let bytes: Uint8Array;

        try {
            bytes = await io.readStdin();
        }
        catch (error) {
            if (error instanceof B24Error) {
                throw error;
            }

            throw new B24Error(1, 'Не удалось прочитать stdin.');
        }

        if (bytes.byteLength > 262144) {
            throw new Error('size');
        }

        const text = new TextDecoder('utf-8', {
            fatal: true
        }).decode(bytes);
        const value: unknown = JSON.parse(text);

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('object');
        }

        return value;
    }
    catch (error) {
        if (error instanceof B24Error) {
            throw error;
        }

        throw new B24Error(2, 'Нужен JSON-объект UTF-8 из stdin, не больше 256 КиБ.');
    }
}
/**
 * Выдаёт JSON только после полного успешного ответа API.
 * Невалидный ответ не становится случайной внутренней ошибкой или частичным stdout.
 */
export async function jsonRequest(
    context: PipelineContext,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    requestSignal?: AbortSignal,
): Promise<unknown> {
    const signal = context.io.signal && requestSignal
        ? AbortSignal.any([context.io.signal, requestSignal]) : requestSignal ?? context.io.signal;

    const bytes = await context.io.request(context.connection, {
        method,
        path,
        ...(body === undefined ? {} : {
            body: JSON.stringify(body), json: true
        }),
    }, { signal });

    try {
        return JSON.parse(new TextDecoder('utf-8', {
            fatal: true
        }).decode(bytes));
    }
    catch {
        throw new B24Error(22, 'GrigDesk вернул повреждённый JSON.');
    }
}
/**
 * HTTP-успех не означает состоявшееся продолжение или перезапуск.
 * История и квитанция остаются в stdout, чтобы оператор повторил только недостающий шаг.
 */
function partialResult(command: string, value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const row = value as Record<string, unknown>;
    const receipt = row.receipt as {
        state?: unknown;
    } | null | undefined;

    return (['gate', 'goto'].includes(command) && row.resumed === false)
        || (command === 'runner-set' && receipt?.state === 'failed')
        || (['arbiter-apply', 'arbiter-resume'].includes(command) && row.outcome === 'resume_failed');
}

/**
 * Запускает один закрытый обработчик после проверки argv и ввода.
 * Локальные команды не читают токен; POST никогда не повторяется.
 */
export async function runPipeline(
    argv: readonly string[],
    runtime: RuntimeInfo,
    io: PipelineIO,
): Promise<number> {
    let mutating = false;

    try {
        const local = argv.length === 1 ? argv[0] : '';

        if (local === '--help' || local === '-h') {
            const commands = Object.entries(COMMANDS).map(([name, spec]) => {
                return '  pipeline ' + name + ' ' + spec.params.map((value) => '<' + value + '>').join(' ');
            });

            await io.writeStdout(
                'pipeline — управление конвейерами GrigDesk.\n' + commands.join('\n') + '\n',
            );

            return 0;
        }
        if (local === '--version') {
            await io.writeStdout('pipeline ' + runtime.version + ' (Node ' + process.version
                + ', ' + process.platform + ' ' + process.arch + ')\n');

            return 0;
        }
        if (local === '--license') {
            await io.writeStdout(runtime.license());

            return 0;
        }

        const commandName = argv[0] ?? '';
        const spec = Object.hasOwn(COMMANDS, commandName) ? COMMANDS[commandName] : undefined;

        if (!spec) {
            throw new B24Error(2, 'Неизвестная команда pipeline. См. pipeline --help.');
        }

        mutating = spec.method === 'POST';

        const values = argumentsOf(spec, argv.slice(1));

        io.signal?.throwIfAborted();

        if (commandName === 'gate' && !values.key!.startsWith('GATE_')) {
            throw new B24Error(2, 'Нужен точный ключ GATE_*.');
        }

        const body = spec.method === 'POST'
            ? spec.body?.(await inputObject(io), values) : undefined;
        const context = {
            io, connection: await resolveConnection(io.env, io)
        };

        if (spec.run) {
            const result = await spec.run(values, context);

            await io.writeStdout(JSON.stringify(result.output) + '\n');

            return result.code ?? 0;
        }
        if (spec.text) {
            await io.writeStdout(await io.request(context.connection, {
                method: 'GET',
                path: spec.path(values),
            }, { signal: io.signal }));

            return 0;
        }

        const result = await jsonRequest(context, spec.method, spec.path(values), body);
        const output = spec.format ? spec.format(result, values) : result;

        await io.writeStdout(JSON.stringify(output) + '\n');

        if (partialResult(argv[0]!, result)) {
            try {
                await io.writeStderr('Решение или настройки сохранены; продолжение не состоялось. '
                    + 'Прочитайте состояние и повторите только продолжение.\n');
            } catch {
                // Структурированный частичный результат уже выдан, код 3 сохраняется.
            }

            return 3;
        }

        return 0;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') {
            return 0;
        }

        const failure = error instanceof B24Error
            ? error : new B24Error(1, 'Не удалось выполнить команду pipeline.');

        const uncertain = mutating && failure.code === 22
            ? ' Исход операции проверьте чтением состояния перед повтором.' : '';

        try {
            await io.writeStderr(failure.message + uncertain + '\n');
        }
        catch {
        }

        return failure.code;
    }
}
