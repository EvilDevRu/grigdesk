import {
    decodeHumanIntent, decodeStageIdentity, decodeStopIdentity,
} from '../../shared/pipeline/arbiterConversation.ts';
import { B24Error } from './errors.ts';
import type { PipelineSpec } from './pipelineApp.ts';
import { inputRecord, inputText } from './pipelineInput.ts';

const root = (task: string) => '/api/tasks/' + task + '/arbiter-conversations';
/**
 * Проверяет именно контракт выбранного намерения, сохраняя UUID и payload.
 * Допуск цели/предложения и durable идемпотентность принадлежат серверу.
 */
function arbiterBody(
    kind: 'start' | 'discuss' | 'diagnose' | 'apply' | 'resume' | 'stop',
    value: unknown,
    values: Record<string, string>,
): Record<string, unknown> {
    try {
        if (kind === 'stop') {
            const row = inputRecord(value, ['operationId']);

            inputText(row.operationId, 500);

            return row;
        }

        const required = kind === 'resume'
            ? ['requestId', 'applyOperationId', 'acceptedEvent', 'expectedCurrentStage']
            : ['requestId', 'expectedStop', ...(kind === 'start' ? [] : ['decisionRevision'])];
        const optional = kind === 'discuss'
            ? ['text', 'questionId', 'optionId', 'customAnswer']
            : kind === 'diagnose' ? ['proposalId']
                : kind === 'apply' ? ['proposalId', 'customAction', 'originalProposalId'] : [];
        const row = inputRecord(value, required, optional);

        if (typeof row.requestId !== 'string'
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
                .test(row.requestId)) {
            throw new Error('requestId');
        }
        if (kind === 'resume') {
            inputText(row.applyOperationId, 500);
            decodeStageIdentity(row.acceptedEvent);
            decodeStageIdentity(row.expectedCurrentStage);

            return row;
        }
        if (decodeStopIdentity(row.expectedStop).task !== values.task) {
            throw new Error('task');
        }
        if (kind !== 'start') {
            if (!Number.isSafeInteger(row.decisionRevision) || Number(row.decisionRevision) < 0) {
                throw new Error('decisionRevision');
            }

            const intent = Object.fromEntries(Object.entries(row).filter(([key]) => {
                return !['requestId', 'expectedStop', 'decisionRevision', 'originalProposalId'].includes(key);
            }));

            decodeHumanIntent(kind, intent);
        }

        return row;
    }
    catch {
        throw new B24Error(2, 'Некорректное exact намерение арбитра.');
    }
}
/**
 * Создаёт фиксированный POST только для одного публичного намерения.
 * Текст обсуждения не может выбрать другой маршрут или URL.
 */
function mutation(
    kind: 'start' | 'discuss' | 'diagnose' | 'apply' | 'resume' | 'stop',
    suffix: string,
): PipelineSpec {
    return {
        params: kind === 'start' || kind === 'stop' ? ['task'] : ['task', 'conversation'],
        method: 'POST',
        path: (v) => root(v.task!) + (v.conversation ? '/' + v.conversation : '') + suffix,
        body: (value, values) => arbiterBody(kind, value, values),
    };
}

export const ARBITER_COMMANDS: Record<string, PipelineSpec> = {
    'arbiter-current': {
        params: ['task'],
        method: 'GET',
        path: (v) => root(v.task!) + '/current',
    },
    'arbiter-show': {
        params: ['task', 'conversation', 'afterSequence', 'knownRevision'],
        defaults: {
            afterSequence: '0', knownRevision: '0'
        },
        method: 'GET',
        path: (v) => root(v.task!) + '/' + v.conversation + '?' + new URLSearchParams({
            afterSequence: v.afterSequence!, knownRevision: v.knownRevision!,
        }),
    },
    'arbiter-journal': {
        params: ['task', 'conversation'],
        method: 'GET',
        path: (v) => root(v.task!) + '/' + v.conversation + '/journal',
        text: true,
    },
    'arbiter-start': mutation('start', ''),
    'arbiter-message': mutation('discuss', '/messages'),
    'arbiter-diagnose': mutation('diagnose', '/diagnose'),
    'arbiter-apply': mutation('apply', '/apply'),
    'arbiter-resume': mutation('resume', '/resume'),
    'arbiter-stop': mutation('stop', '/stop'),
};
