import { B24Error } from './errors.ts';
import type { PipelineSpec } from './pipelineApp.ts';
import { controlBody } from './pipelineControl.ts';
import { inputRecord } from './pipelineInput.ts';

/**
 * Принимает отдельно stage snapshot либо полный snapshot подготовительной фазы.
 * Выбор latest/подмена одного вида identity другим здесь не выполняются.
 */
function preludeControl(value: unknown, values: Record<string, string>): Record<string, unknown> {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'expectedPrelude')) {
        return controlBody(value, values);
    }

    const row = inputRecord(value, ['expectedPrelude']);
    const identity = inputRecord(row.expectedPrelude, ['profile', 'attempt', 'orchPid', 'bootstrap']);

    if (typeof identity.profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(identity.profile)
      || typeof identity.attempt !== 'string' || !/^a_[a-f0-9]{32}$/u.test(identity.attempt)
      || !Number.isSafeInteger(identity.orchPid) || Number(identity.orchPid) < 0) {
        throw new B24Error(2, 'Некорректная identity подготовительной фазы.');
    }

    if (identity.bootstrap !== null) {
        const stop = inputRecord(identity.bootstrap, ['visitId', 'stopHash', 'state', 'decisionHash']);

        if (typeof stop.visitId !== 'string' || !/^b_[a-f0-9]{32}$/u.test(stop.visitId)
          || typeof stop.stopHash !== 'string' || !/^[a-f0-9]{64}$/u.test(stop.stopHash)
          || !['waiting', 'answered', 'running'].includes(String(stop.state))
          || (stop.decisionHash !== null
            && (typeof stop.decisionHash !== 'string' || !/^[a-f0-9]{64}$/u.test(stop.decisionHash)))) {
            throw new B24Error(2, 'Некорректная bootstrap identity.');
        }
    }

    return row;
}

export const PRELUDE_COMMANDS: Record<string, PipelineSpec> = {
    'prelude-state': {
        params: ['task'],
        method: 'GET',
        path: (v) => '/api/tasks/' + v.task + '/prelude-state',
    },
    stop: {
        params: ['task'],
        method: 'POST',
        path: (v) => '/api/tasks/' + v.task + '/stop',
        body: preludeControl,
    },
    resume: {
        params: ['task'],
        method: 'POST',
        path: (v) => '/api/tasks/' + v.task + '/resume',
        body: preludeControl,
    },
};
