import { factorySnapshotHash } from '../../shared/node/factorySnapshotHash.ts';
import { isTaskSourceId } from '../../shared/tasks/taskReference.ts';
import { B24Error } from './errors.ts';
import type { PipelineSpec } from './pipelineApp.ts';
import { inputRecord } from './pipelineInput.ts';
/**
 * Запуск сохраняет полный источник, профиль и выбранный пользователем маршрут.
 * Тело не дополняется текущими defaults и не повторяется после неизвестного результата.
 */
function launchBody(value: unknown): Record<string, unknown> {
    const row = inputRecord(value,
        ['profile', 'route', 'source', 'expectedCatalogHash', 'expectedLaunch'],
        ['title', 'description', 'acceptanceCriteria', 'sourceUrl', 'runnerPrimary',
        'deliveryTargets', 'instrumentationFiles', 'diagnosisKind', 'diagnosisSignal']);

    if (typeof row.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.profile)
        || typeof row.route !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/u.test(row.route)
        || !isTaskSourceId(row.source)
        || ![row.expectedCatalogHash, row.expectedLaunch]
            .every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))) {
        throw new B24Error(2, 'Запуску нужны явные profile/route/source и SHA256 прочитанных вариантов.');
    }

    return row;
}

export const LAUNCH_COMMANDS: Record<string, PipelineSpec> = {
    'launch-options': {
        params: ['task', 'profile', 'source'],
        method: 'GET',
        path: (v) => '/api/tasks/' + v.task + '/launch-options?'
            + new URLSearchParams({
                profile: v.profile!, source: v.source!
            }),
        format: (options) => ({
            options, expectedLaunch: factorySnapshotHash(options)
        }),
    },
    launch: {
        params: ['task'],
        method: 'POST',
        path: (v) => '/api/tasks/' + v.task + '/launch',
        body: launchBody,
    },
};
