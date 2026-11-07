import { extraStubs, prepareStore } from './extraCases.mjs';
import assert from 'node:assert/strict';
import { compileVue, webFile } from '../../helpers/compile-vue.js';
import { installUiBrowser } from '../../helpers/ui-components.js';


export { documentDto, usageDto, propCases, portCases } from './cases.mjs';

const apiPort = `
export const api = { get: (...args) => globalThis.__loadingSurface.api(...args) };
export { failureText } from './src/shared/apiClient.ts';
`;
/**
 * Компоненты получают настоящие UI-кирпичики и внешнее управляемое ожидание.
 * До проверки нового поведения отдельно подтверждаются ready/empty/error состояния фикстуры.
 */
export async function mountSurface(t, spec) {
    await installUiBrowser(t);

    const { reactive, nextTick } = await import('../../../../web/node_modules/vue/index.mjs');
    const { mount, flushPromises } = await import(
        '../../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    let pending = Promise.withResolvers();
    const calls = [];
    const harness = {
        api: (url) => {
            assert.ok(spec.endpoint.test(url), `ожидаемый API ${url}`);
            calls.push(url);

            return pending.promise;
        },
        store: reactive(spec.state ? structuredClone(spec.state) : {}),
    };

    globalThis.__loadingSurface = harness;

    prepareStore(harness.store);

    const stubs = {
        ...extraStubs(),
        '../../shared/apiClient.ts': apiPort,
        '../../stores/docker': 'export const useDockerStore = () => globalThis.__loadingSurface.store;',
        '../../stores/plugins.ts': `export const usePluginsStore = () => ({ byId: () => ({ values: {} }) });`,
        '../../../stores/plugins.ts': `export const usePluginsStore = () => ({
            loadSetup: () => globalThis.__loadingSurface.api('/fixture/setup'),
        });`,
        '../../shared/projectsApi.ts': 'export const projectsApi = { list: async () => [] };',
    };

    if (spec.id === 'docker-containers') {
        harness.store.isBusy = () => false;
    }


    const component = await compileVue(webFile(spec.file), { stubs });
    const wrapper = mount(component, { props: spec.pending });

    t.after(() => {
        wrapper.unmount();
        delete globalThis.__loadingSurface;
    });

    return {
        wrapper,
        calls,
        get pending() {
            return pending;
        },
        reset() {
            pending = Promise.withResolvers();
        },
        state: harness.store,
        /**
         * Разрешает только удержанный внешний ответ или входные props.
         * Настоящие setup, watchers и DOM компонента продолжают работать сами.
         */
        async ready(empty = false) {
            if (spec.state) {
                Object.assign(harness.store, empty ? spec.emptyState : spec.readyState);
            }
            else if (spec.endpoint) {
                pending.resolve(empty ? spec.emptyResponse : spec.response);
            }
            else {
                await wrapper.setProps(empty ? spec.empty : spec.ready);
            }

            await nextTick();
            await flushPromises();
            await flushPromises();
        },
    };
}
