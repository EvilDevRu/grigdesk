import { factorySnapshotHash } from '../../shared/node/factorySnapshotHash.ts';
import { B24Error } from './errors.ts';
import type { PipelineSpec } from './pipelineApp.ts';

const task = (id: string) => '/api/tasks/' + encodeURIComponent(id);
/**
 * Описывает только чтения штатных API; адрес не принимается от пользователя.
 * Каждая команда использует единственный целевой task/profile/board.
 */
export const READ_COMMANDS: Record<string, PipelineSpec> = {
    list: {

        params: [],
        method: 'GET',
        path: () => '/api/tasks?sources=1',

    },
    status: {

        params: ['task'],
        method: 'GET',
        path: (v) => task(v.task!),

    },
    state: {

        params: ['task'],
        method: 'GET',
        path: (v) => task(v.task!) + '/mobile-state',

    },
    graph: {

        params: ['task'],
        method: 'GET',
        path: (v) => task(v.task!) + '/graph',

    },
    doc: {

        params: ['task', 'doc'],
        method: 'GET',

        path: (v) => task(v.task!) + '/doc/' + encodeURIComponent(v.doc!),
    format: (value, values) => {
      const doc = value as { text: unknown };

      if (typeof doc?.text !== 'string') {
        throw new B24Error(22, 'API документа не вернул text');
      }

      return { ...doc, basis: { name: values.doc, hash: factorySnapshotHash(doc.text) } };
    },


    },
    profiles: {

        params: [],
        method: 'GET',
        path: () => '/api/profiles',

    },
    runners: {

        params: [],
        method: 'GET',
        path: () => '/api/factory/runners',

    },
    slots: {

        params: ['profile'],
        method: 'GET',

        path: (v) => '/api/factory/slots?' + new URLSearchParams({
            profile: v.profile!
        }),

    },
    source: {

        params: ['board'],
        method: 'GET',

        path: (v) => '/api/tracker/' + encodeURIComponent(v.board!) + '/context',

    },
};
