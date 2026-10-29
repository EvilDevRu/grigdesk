import { readFile } from 'node:fs/promises';
import ts from '../../../../web/node_modules/typescript/lib/typescript.js';

import { compileVue, webFile } from '../../helpers/compile-vue.js';
import { installUiBrowser } from '../../helpers/ui-components.js';

/**
 * Панель сохраняет настоящий setup и UI, а операции соединения заменены записываемым портом.
 * Без активной сессии терминал не открывается; готовые строки используют синтетические записи.
 */
export async function mountInfrastructure(t, kind, ready = false) {
    await installUiBrowser(t);

    const { reactive, nextTick } = await import('../../../../web/node_modules/vue/index.mjs');
    const { mount, flushPromises } = await import(
        '../../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const isSsh = kind === 'ssh';
    const rows = isSsh ? 'connections' : 'profiles';
    const entry = {
        id: 'fixture',
        projectId: 'fixture',
        label: 'Синтетическое подключение',
        host: 'fixture.invalid',
        port: isSsh ? 22 : 5432,
        user: 'fixture',
        role: 'read',
        engine: 'postgres',
        via: 'direct',
    };
    const store = reactive({
        loading: !ready,
        error: '',
        projectsLoading: false,
        projects: [{ id: 'fixture', title: 'Синтетический проект' }],
        [rows]: ready ? [entry] : [],
        sessions: [],
        sshSessions: [],
        queries: [],
        schemas: {},
        audit: [],
        files: [],
        approvals: [],
        engines: [{ id: 'postgres', label: 'PostgreSQL' }],
        remotePath: '.',
        activeId: '',
    });
    const calls = [];
    const pending = Promise.withResolvers();
    let schema = Promise.withResolvers();
    const path = webFile(isSsh ? 'src/views/ssh/SshPanel.vue' : 'src/views/db/DbPanel.vue');
    const raw = await readFile(path, 'utf8');
    const script = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
    const ast = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true);
    const actionPath = `../../actions/${kind}`;
    const node = ast.statements.find((statement) => ts.isImportDeclaration(statement)
        && statement.moduleSpecifier.text === actionPath);
    const actionNames = node.importClause.namedBindings.elements.map((item) => item.name.text);

    globalThis.__loadingInfrastructure = {
        store,
        /**
         * Записывает действия панели без соединения с реальной машиной.
         * Первое чтение списка удерживается до явного resolve теста.
         */
        invoke(name) {
            calls.push(name);

            if (name === 'loadDbSchema') {
                return schema.promise;
            }

            return name === (isSsh ? 'loadSsh' : 'loadDb') ? pending.promise : Promise.resolve();
        },
    };

    const exports = actionNames.map((name) => name.startsWith('use')
        ? `export const ${name} = () => globalThis.__loadingInfrastructure.store;`
        : `export const ${name} = () => globalThis.__loadingInfrastructure.invoke('${name}');`).join('\n');
    const component = await compileVue(path, {
        expose: isSsh ? [] : ['selectedSessionId', 'loadSchema'],
        stubs: {
            [actionPath]: exports,
            '../../shared/chatApprovals.ts': 'export const useChatApprovals = () => ({ pending: {} });',
            '@xterm/xterm': 'export class Terminal {}',
            '@xterm/addon-fit': 'export class FitAddon {}',
        },
    });
    const wrapper = mount(component);

    t.after(() => {
        wrapper.unmount();
        delete globalThis.__loadingInfrastructure;
    });
    await flushPromises();

    return {
        wrapper,
        get schema() {
            return schema;
        },
        resetSchema() {
            schema = Promise.withResolvers();
        },
        flush: flushPromises,
        store,
        calls,
        selector: isSsh ? '.ssh-connection' : '.db-profile',
        /**
         * Подтверждает синтетический список и завершает только его чтение.
         * Смена ready выполняется настоящими watchers панели.
         */
        async resolve() {
            store[rows] = [entry];
            store.loading = false;
            pending.resolve();
            await nextTick();
            await flushPromises();
        },
        async refreshing(value) {
            store.loading = value;
            await nextTick();
        },
    };
}
