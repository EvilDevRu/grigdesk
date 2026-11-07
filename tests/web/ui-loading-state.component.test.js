import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

let mount;
let flushPromises;
let nextTick;
let h;
let locale;
let LoadingState;
let asyncView;
let ui;

before(async () => {
    await installUiBrowser({ after });
    ({ mount, flushPromises } = await import(
        '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    ));
    ({ nextTick, h } = await import('../../web/node_modules/vue/index.mjs'));
    locale = await import('../../web/src/services/locale.ts');
    globalThis.__loadingLocale = locale;

    const stubs = {
        '../../services/locale.ts': `export const {
      t, resolveUiText, messageRef, uiLocale, setUiLocale, snapshotText, locales,
    } = globalThis.__loadingLocale;`,
    };

    LoadingState = await compileVue(webFile('src/components/feedback/UiLoadingState.vue'), { stubs });
    ({ asyncView } = await compileModule(webFile('src/shared/asyncView.ts'), { stubs }));
    ui = await compileModule(webFile('src/ui.ts'), { stubs });
});
after(() => {
    locale?.setUiLocale('ru');
    delete globalThis.__loadingLocale;
});
test('загрузка объявляет один статус, силуэты скрыты от чтения и не изображают прогресс', async (t) => {
    const wrapper = mount(LoadingState);

    t.after(() => wrapper.unmount());
    assert.equal(wrapper.findAll('[role="status"]').length, 1);
    assert.equal(wrapper.find('[role="progressbar"]').exists(), false);
    assert.equal(wrapper.find('.ui-loading-state__skeleton').attributes('aria-hidden'), 'true');
    assert.ok(
        wrapper.findAll('[data-ui-skeleton]').length > 0,
        'fallback собран из общих кирпичиков'
    );
    assert.equal(wrapper.find('.ui-spinner').attributes('aria-hidden'), 'true');

    for (const variant of ['cards', 'document', 'inline']) {
        await wrapper.setProps({ variant });
        assert.equal(wrapper.attributes('data-variant'), variant);
        assert.equal(wrapper.find('.ui-loading-state__skeleton').exists(), variant !== 'inline');
    }
});
test('LOAD-KIT: публичные формы, раскладки и слот вместо fallback', async (t) => {
    assert.ok(ui.UiSkeleton, 'UiSkeleton доступен через публичную границу UI');
    assert.ok(ui.UiSkeletonLayout, 'UiSkeletonLayout доступен через публичную границу UI');

    for (const shape of ['line', 'block', 'circle']) {
        const brick = mount(ui.UiSkeleton, { props: {
                shape,
            width: '123px',
            height: '24px'
            } });

        t.after(() => brick.unmount());
        assert.ok(Object.hasOwn(brick.attributes(), 'data-ui-skeleton'));
        assert.equal(brick.attributes('aria-hidden'), 'true');
        assert.equal(brick.element.style.width, '123px');
        assert.equal(brick.element.style.height, '24px');
        assert.equal(brick.attributes('role'), undefined);
        assert.equal(brick.find('[tabindex], input, button').exists(), false);
    }
    for (const layout of ['list', 'form', 'text']) {
        const composition = mount(ui.UiSkeletonLayout, { props: {
                layout,
            rows: 2,
            header: false
            } });

        t.after(() => composition.unmount());
        assert.ok(composition.findAll('[data-ui-skeleton]').length >= 2);
        assert.equal(composition.find('[role="status"]').exists(), false);
    }

    const custom = mount(LoadingState, { slots: { default: '<section data-custom>Свой каркас</section>' } });

    t.after(() => custom.unmount());
    assert.equal(custom.find('[data-custom]').exists(), true, 'default slot показан');
    assert.equal(custom.findAll('[data-ui-skeleton]').length, 0, 'fallback заменён слотом');
    await custom.setProps({ variant: 'inline' });
    assert.equal(
        custom.find('[data-custom]').exists(),
        false,
        'inline не показывает декоративный слот'
    );
    assert.equal(custom.find('.ui-spinner').exists(), true);
});
test('LOAD-A11Y: слот декоративен, один переводимый статус и видимое пояснение', async (t) => {
    assert.ok(ui.UiSkeleton, 'общий декоративный кирпичик существует');

    const wrapper = mount(LoadingState, {
        props: { description: 'Объяснение недоступности действия' },
        slots: { default: () => h(ui.UiSkeleton) },
    });

    t.after(() => {
        wrapper.unmount();
        locale.setUiLocale('ru');
    });
    assert.equal(wrapper.findAll('[role="status"]').length, 1);
    assert.equal(wrapper.find('[role="progressbar"]').exists(), false);
    assert.ok(wrapper.get('[role="status"]').text().includes(locale.t('core.loading')));
    assert.ok(wrapper.get('[role="status"]').text().includes('Объяснение недоступности действия'));

    for (const brick of wrapper.findAll('[data-ui-skeleton]')) {
        assert.equal(brick.attributes('aria-hidden'), 'true');
    }

    locale.setUiLocale('en');
    await nextTick();
    assert.ok(wrapper.get('[role="status"]').text().includes(locale.t('core.loading')));
    await wrapper.setProps({ showLabel: true });
    assert.ok(wrapper.get('[role="status"]').text().includes(locale.t('core.loading')));
});
test('LOAD-FAILED: отказ убирает fallback и слот, сохраняя объявляемый статус', async (t) => {
    const fallback = mount(LoadingState, { props: { failed: true } });
    const custom = mount(LoadingState, {
        props: { failed: true },
        slots: { default: '<div data-custom>Каркас</div>' },
    });

    t.after(() => {
        fallback.unmount();
        custom.unmount();
    });
    assert.equal(fallback.find('.ui-loading-state__skeleton').exists(), false);
    assert.equal(fallback.findAll('[data-ui-skeleton]').length, 0);
    assert.equal(custom.find('[data-custom]').exists(), false);
    assert.equal(custom.findAll('[role="status"]').length, 1);
    await custom.setProps({ failed: false });
    assert.equal(custom.find('[data-custom]').exists(), true);
});
test('общая подпись меняет язык, собственный текст остаётся данными и не исполняется', async (t) => {
    locale.setUiLocale('ru');

    const wrapper = mount(LoadingState);

    t.after(() => {
        wrapper.unmount();
        locale.setUiLocale('ru');
    });
    assert.equal(wrapper.text(), locale.t('core.loading'));
    locale.setUiLocale('en');
    await nextTick();
    assert.equal(wrapper.text(), locale.t('core.loading'));
    await wrapper.setProps({ label: '<b>core.loading</b>', description: 'Данные Я🦊' });
    assert.equal(wrapper.find('b').exists(), false);
    assert.ok(wrapper.text().includes('<b>core.loading</b>'));
    assert.ok(wrapper.text().includes('Данные Я🦊'));
});
test('ленивая панель показывает общую загрузку до готовности и снимает её после успеха', async (t) => {
    const result = Promise.withResolvers();
    const Pending = asyncView(() => result.promise);
    const wrapper = mount({ components: { Pending }, template: '<div><Pending /></div>' });

    t.after(() => wrapper.unmount());
    assert.equal(wrapper.find('[data-ui-loading]').exists(), true);
    result.resolve({ template: '<section data-loaded>Панель готова</section>' });
    await flushPromises();
    await setImmediate();
    await nextTick();
    assert.equal(wrapper.find('[data-ui-loading]').exists(), false);
    assert.equal(wrapper.find('[data-loaded]').exists(), true);
});
test('ленивая панель сохраняет специальный каркас и показывает ошибку после отказа', async (t) => {
    const result = Promise.withResolvers();
    const failures = [];
    const Pending = asyncView(
        () => result.promise,
        { template: '<div data-special-loading>Каркас кода</div>' },
        (error) => failures.push(error.message)
    );
    const wrapper = mount({ components: { Pending }, template: '<div><Pending /></div>' }, {
        global: { config: { warnHandler() {
                }, errorHandler() {
                } } },
    });

    t.after(() => wrapper.unmount());
    assert.equal(wrapper.find('[data-special-loading]').exists(), true);
    assert.equal(wrapper.find('[data-ui-loading]').exists(), false);
    result.reject(new Error('Синтетический отказ чанка'));
    await flushPromises();
    await setImmediate();
    await nextTick();
    assert.equal(wrapper.find('[data-special-loading]').exists(), false);
    assert.equal(wrapper.find('[role="alert"]').exists(), true);
    assert.deepEqual(failures, ['Синтетический отказ чанка']);
});

test('LOAD-LAZY: поздний resolve после unmount не создаёт вторую панель', async (t) => {
    const result = Promise.withResolvers();
    const { onMounted } = await import('../../web/node_modules/vue/index.mjs');
    let mounts = 0;
    const Ready = {
        setup() {
            onMounted(() => {
                mounts += 1;
            });

            return () => h('section', { 'data-ready-panel': true });
        },
    };
    const Pending = asyncView(() => result.promise);
    const wrapper = mount(Pending);

    assert.equal(wrapper.find('[data-ui-loading]').exists(), true);
    wrapper.unmount();
    result.resolve(Ready);
    await flushPromises();
    await setImmediate();
    await nextTick();
    assert.equal(mounts, 0);
});
