import { decodeStageRunnerApply, } from '../../shared/pipeline/stageRunnerSettings.ts';
import { B24Error } from './errors.ts';
import type { PipelineSpec } from './pipelineApp.ts';
import { controlBody } from './pipelineControl.ts';
import { inputRecord, inputText } from './pipelineInput.ts';
/**
 * Передаёт уже прочитанный exact apply и сохраняет null/пустой effort.
 * Неверный DTO и расхождение task отклоняются до запроса.
 */
function settingsBody(value: unknown, values: Record<string, string>): Record<string, unknown> {
    try {
        const payload = decodeStageRunnerApply(value);

        if (payload.identity.task !== values.task) {
            throw new Error('task');
        }

        return payload as unknown as Record<string, unknown>;
    }
    catch {
        throw new B24Error(2, 'Некорректный exact DTO настроек этапа.');
    }
}
/**
 * Bootstrap адресуется собственным visitId/stopHash, включая период до cursor.
 * Сохранённый ответ сам по себе не запускает следующий ход.
 */
function bootstrapBody(value: unknown): Record<string, unknown> {
    const row = inputRecord(value, ['profile', 'attempt', 'phase', 'node', 'visitId', 'stopHash', 'answer']);

    if (row.phase !== 'bootstrap' || row.node !== 'scout'
        || typeof row.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.profile)
        || typeof row.attempt !== 'string' || !/^a_[a-f0-9]{32}$/u.test(row.attempt)
        || typeof row.visitId !== 'string' || !/^b_[a-f0-9]{32}$/u.test(row.visitId)
        || typeof row.stopHash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.stopHash)) {
        throw new B24Error(2, 'Некорректная identity bootstrap.');
    }
    if (typeof row.answer !== 'string' || !row.answer.trim()
        || [...row.answer].length > 20000
        || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(row.answer)) {
        throw new B24Error(2, 'Некорректный текст ответа bootstrap.');
    }

    return row;
}

export const SETTINGS_COMMANDS: Record<string, PipelineSpec> = {
    'runner-options': {
        params: ['task', 'profile', 'attempt', 'node', 'stage', 'provider'],
        method: 'GET',
        path: (v) => '/api/tasks/' + v.task + '/runner/options?' + new URLSearchParams({
            profile: v.profile!,
            attempt: v.attempt!,
            node: v.node!,
            stage: v.stage!,
            provider: v.provider!,
        }),
    },
    'runner-set': {
        params: ['task'],
        method: 'POST',
        path: (v) => '/api/tasks/' + v.task + '/runner/settings',
        body: settingsBody,
    },
    'bootstrap-answer': {
        params: ['task'],
        method: 'POST',
        path: (v) => '/api/tasks/' + v.task + '/bootstrap-answer',
        body: bootstrapBody,
    },
    'runtime-rebind': {
        params: ['task'],
        method: 'POST',
        path: (v) => '/api/tasks/' + v.task + '/runtime-rebind',
        body: controlBody,
    },
};
