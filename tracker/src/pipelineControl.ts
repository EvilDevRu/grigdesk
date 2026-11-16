import { B24Error } from './errors.ts';
import type { PipelineSpec } from './pipelineApp.ts';
import { inputRecord, inputText } from './pipelineInput.ts';
/**
 * Проверяет весь снимок текущего head; частичный attempt не становится допуском.
 * Реальное совпадение с trusted состоянием проверяет сервер внутри task lock.
 */
export function decodeMobile(value: unknown): Record<string, unknown> {
    const row = inputRecord(value, ['profile', 'attempt', 'node', 'state', 'stop',
        'sequence', 'headEventHash', 'orchPid', 'terminal']);

    if (typeof row.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.profile)
        || typeof row.attempt !== 'string' || !/^a_[a-f0-9]{32}$/u.test(row.attempt)
        || typeof row.state !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(row.state)
        || !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 0
        || !Number.isSafeInteger(row.orchPid) || Number(row.orchPid) < 0
        || typeof row.headEventHash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.headEventHash)
        || ['node', 'stop', 'terminal'].some((key) => row[key] !== null
            && (typeof row[key] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row[key])))) {
        throw new B24Error(2, 'Некорректный exact снимок попытки.');
    }

    return row;
}
/**
 * Решение передаётся с тем снимком, который прочитал вызывающий агент.
 * Ни профиль, ни attempt, ни комментарий не подменяются после конфликта.
 */
export function controlBody(value: unknown, values: Record<string, string>): Record<string, unknown> {
    const row = inputRecord(value, ['expectedMobile'], ['comment', 'expectedBasis']);

    decodeMobile(row.expectedMobile);

    if (values.key !== undefined && (values.decision !== 'approve' || row.comment !== undefined)) {
        inputText(row.comment);
    }
    if (row.expectedBasis !== undefined) {
        const basis = inputRecord(row.expectedBasis, ['name', 'hash']);

        if (!['plan', 'report', 'diag'].includes(String(basis.name))
            || typeof basis.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(basis.hash)) {
            throw new B24Error(2, 'Неверный отпечаток документа.');
        }
    }

    return row;
}

export const CONTROL_COMMANDS: Record<string, PipelineSpec> = {
    stop: {

        params: ['task'],
        method: 'POST',

        path: (v) => '/api/tasks/' + v.task + '/stop',
        body: controlBody,

    },
    resume: {

        params: ['task'],
        method: 'POST',

        path: (v) => '/api/tasks/' + v.task + '/resume',
        body: controlBody,

    },
    goto: {

        params: ['task', 'key'],
        method: 'POST',

        path: (v) => '/api/tasks/' + v.task + '/stage/' + v.key + '/running',
        body: controlBody,

    },
    gate: {

        params: ['task', 'key', 'decision'],
        method: 'POST',

        path: (v) => '/api/tasks/' + v.task + '/gate/' + v.key + '/' + v.decision,

        body: controlBody,

    },
};
