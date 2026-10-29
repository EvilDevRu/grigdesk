import assert from 'node:assert/strict';

import { compilePipelineView } from '../../helpers/pipeline-view.js';
import { installUiBrowser } from '../../helpers/ui-components.js';

let serial = 0;

/**
 * Конвейер получает настоящий setup, а ответ списка удерживается внешним API-портом.
 * Compact и loops читаются из тех же device-ключей, что в продуктовом PipelineView.
 */
export async function mountLoadingPipeline(t, compact = false, loops = false) {
    const browser = await installUiBrowser(t);

    browser.localStorage.setItem('grigdesk-compact', compact ? '1' : '0');
    browser.localStorage.setItem('grigdesk-loops', loops ? '1' : '0');

    const { createPinia, defineStore } = await import('../../../../web/node_modules/pinia/dist/pinia.mjs');
    const { mount, flushPromises } = await import(
        '../../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const prefix = `__loadingPipeline${serial += 1}`;
    const pending = Promise.withResolvers();
    const calls = [];

    globalThis[`${prefix}Api`] = {
        get(url) {
            calls.push(url);
            assert.equal(url, '/api/tasks');

            return pending.promise;
        },
    };
    globalThis[`${prefix}UiStore`] = defineStore(`${prefix}-ui`, { actions: { openTask() {} } });
    globalThis[`${prefix}TasksStore`] = defineStore(`${prefix}-tasks`, {
        actions: { async load() {
            return {};
        }, title() {
            return 'Синтетическая задача';
        } },
    });
    globalThis[`${prefix}BoardStore`] = defineStore(`${prefix}-board`, {
        state: () => ({ data: null }),
        actions: { async load() {} },
    });

    const component = await compilePipelineView(prefix, {
        realGraph: true,
        expose: ['stage', 'stageDoc', 'stageDocLoading'],
    });
    const wrapper = mount(component, { global: { plugins: [createPinia()], stubs: { teleport: true } } });

    t.after(() => {
        wrapper.unmount();

        for (const suffix of ['Api', 'UiStore', 'TasksStore', 'BoardStore']) {
            delete globalThis[`${prefix}${suffix}`];
        }
    });
    await flushPromises();

    return {
        wrapper,
        calls,
        pending,
        async resolve() {
            pending.resolve({ tasks: [] });
            await flushPromises();
            await flushPromises();
        },
    };
}
