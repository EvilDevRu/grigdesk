import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTION, button, deferred, entry, mountSandboxes, selectStand, } from './helpers/sandboxes-layout.js';

const raiseText = (target) => `Поднять песочницу профиля «demo-shop» ${target}?\n\n`
    + 'Скрипт профиля создаст worktree, контейнеры и свои схемы данных. '
    + 'Обычно это 12–15 минут и один занятый слот стенда.';
const downText = (force) => 'Снести стенд t990001?\n\n' + (force
    ? 'Worktree будет удалён вместе с незакоммиченными изменениями — профиль сохранит их патчем в архив.'
    : 'Контейнеры и схемы данных будут удалены. Незакоммиченное в worktree сохраняется: '
        + 'скрипт профиля оставит каталог и предупредит об этом.');
/**
 * Форма открывается через прежнюю доступную кнопку, если ещё скрыта.
 * Пустой реестр на исходном коде уже показывает её без отдельного переключателя.
 */
async function openForm(wrapper) {
    if (!wrapper.find('#sandboxes-create').isVisible()) {
        await wrapper.find('[aria-controls="sandboxes-create"]').trigger('click');
    }
}
/**
 * Отмены не должны затрагивать ни одну инфраструктурную операцию.
 * Загрузка обзора и подписка разрешены и потому исключены из этой проверки.
 */
function mutations(harness) {
    return harness.calls.filter(([kind]) => ['raise', 'dismantle', 'run'].includes(kind));
}

test('подтверждения и аргументы сохраняют прежние тексты и отмену', async (t) => {
    const { wrapper, harness, state, flushPromises } = await mountSandboxes(t, {
        sandboxes: [entry({ actions: [ACTION] })],
    });

    await openForm(wrapper);
    harness.confirmed = false;
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    assert.deepEqual(harness.confirmations.pop(), {
        text: raiseText('без задачи (служебный номер)'),
        options: { title: 'Подъём песочницы', okText: 'Поднять' },
    });
    assert.deepEqual(mutations(harness), []);
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('input[inputmode="numeric"]').setValue('12345');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    assert.equal(harness.confirmations.pop().text, raiseText('задачи 12345'));
    assert.deepEqual(mutations(harness), []);
    harness.confirmed = true;
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    assert.deepEqual(mutations(harness), [['raise', 'demo-shop', '12345']]);
    harness.calls.length = 0;
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    assert.deepEqual(mutations(harness), [['raise', 'demo-shop', null]]);
    harness.calls.length = 0;
    // Подробности могут быть скрыты открытой формой после переделки оболочки.
    // Закрытие возвращает выбранный стенд, не затрагивая данные формы.
    const toggle = wrapper.find('[aria-controls="sandboxes-create"]');

    if (toggle.attributes('aria-expanded') === 'true') {
        await toggle.trigger('click');
    }

    await selectStand(wrapper, '990001');

    for (const force of [false, true]) {
        harness.confirmed = false;
        await button(wrapper, force ? 'Снести вместе с изменениями' : 'Снести стенд').trigger('click');
        await flushPromises();
        assert.deepEqual(harness.confirmations.pop(), {
            text: downText(force),
            options: {
                title: 'Снос стенда',
                okText: 'Снести',
                danger: true
            },
        });
        assert.deepEqual(mutations(harness), []);
        harness.confirmed = true;
        await button(wrapper, force ? 'Снести вместе с изменениями' : 'Снести стенд').trigger('click');
        await flushPromises();
        assert.deepEqual(mutations(harness), [['dismantle', '990001', force]]);
        harness.calls.length = 0;
    }

    harness.answers = [' 42 ', '  полный  '];
    harness.confirmations.length = 0;
    await button(wrapper, ACTION.label).trigger('click');
    await flushPromises();
    assert.deepEqual(harness.prompts, [
        {
            title: 'Проверить стенд — стенд t990001',
            text: 'Номер проекта. из песочницы',
            placeholder: 'целое число',
            okText: 'Дальше',
        },
        {
            title: 'Проверить стенд — стенд t990001',
            text: 'Режим',
            placeholder: '',
            okText: 'Дальше',
        },
    ]);
    assert.deepEqual(harness.confirmations, [{
            text: `Проверить стенд на стенде t990001?\n\n${ACTION.confirm}`,
            options: { title: 'Прогон на стенде', okText: 'Запустить' },
        }]);
    assert.deepEqual(mutations(harness), [['run', '990001', 'check', { project: '42', mode: 'полный' }]]);

    for (const answers of [[null], ['   '], ['42', null]]) {
        harness.calls.length = 0;
        harness.confirmations.length = 0;
        harness.answers = answers;
        await button(wrapper, ACTION.label).trigger('click');
        await flushPromises();
        assert.deepEqual(mutations(harness), []);
        assert.equal(harness.confirmations.length, 0);
    }

    harness.answers = ['42', ''];
    harness.confirmed = false;
    await button(wrapper, ACTION.label).trigger('click');
    await flushPromises();
    assert.deepEqual(mutations(harness), []);
    state.sandboxes = [entry({ actions: [{
                    ...ACTION,
                    confirm: '',
                    args: []
                }] })];
    harness.confirmed = true;
    await flushPromises();
    await button(wrapper, ACTION.label).trigger('click');
    await flushPromises();
    assert.equal(harness.confirmations.at(-1).text,
        `Проверить стенд на стенде t990001?\n\n${ACTION.description}`);
});
test('действие и поздний журнал принадлежат исходному стенду', async (t) => {
    const a = entry({ actions: [ACTION] });
    const b = entry({
        task: '990002',
        profile: 'demo-tools',
        actions: [ACTION]
    });
    const { wrapper, harness, state, flushPromises } = await mountSandboxes(t, { sandboxes: [a] });
    const prompt = deferred();
    const confirm = deferred();

    harness.prompt = () => prompt.promise;
    harness.confirm = () => confirm.promise;
    await button(wrapper, ACTION.label).trigger('click');
    state.sandboxes = [b];
    await flushPromises();
    prompt.resolve('42');
    await flushPromises();
    confirm.resolve(true);
    await flushPromises();
    assert.deepEqual(mutations(harness), [['run', '990001', 'check', { project: '42', mode: '42' }]]);

    const down = deferred();

    state.sandboxes = [a];
    await flushPromises();
    await selectStand(wrapper, a.task);
    harness.confirm = () => down.promise;
    await button(wrapper, 'Снести стенд').trigger('click');
    state.sandboxes = [b];
    await flushPromises();
    down.resolve(true);
    await flushPromises();
    assert.deepEqual(mutations(harness).at(-1), ['dismantle', '990001', false]);
    state.sandboxes = [a];
    state.jobs = [{
            task: a.task,
            action: 'run',
            state: 'done',
            message: 'Готово'
        }];
    await flushPromises();
    await selectStand(wrapper, a.task);

    const log = deferred();

    harness.log = () => log.promise;
    await button(wrapper, 'Журнал задания').trigger('click');
    state.sandboxes = [b];
    state.jobs = [{
            task: b.task,
            action: 'run',
            state: 'done',
            message: 'Итог B'
        }];
    await flushPromises();
    log.resolve({
        task: a.task,
        text: 'ПОЗДНИЙ ЖУРНАЛ A',
        truncated: false
    });
    await flushPromises();
    assert.equal(wrapper.text().includes('ПОЗДНИЙ ЖУРНАЛ A'), false);
    assert.match(wrapper.text(), /Итог B/);
});
test('черновик формы переживает сворачивание', async (t) => {
    const { wrapper, harness, flushPromises } = await mountSandboxes(t);

    await openForm(wrapper);
    await wrapper.find('form select').setValue('demo-tools');
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('input[inputmode="numeric"]').setValue('не номер');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    assert.equal(harness.confirmations.length, 0);
    assert.match(wrapper.find('form').text(), /Нужен номер задачи/);
    await wrapper.find('input[inputmode="numeric"]').setValue('12345');
    await wrapper.find('[aria-controls="sandboxes-create"]').trigger('click');
    await wrapper.find('[aria-controls="sandboxes-create"]').trigger('click');
    assert.equal(wrapper.find('form select').element.value, 'demo-tools');
    assert.equal(wrapper.find('[role="switch"]').attributes('aria-checked'), 'false');
    assert.equal(wrapper.find('input[inputmode="numeric"]').element.value, '12345');
});
test('форма подъёма доступна при пустом реестре и во время первого подъёма', async (t) => {
    const { wrapper, harness, state, flushPromises } = await mountSandboxes(t, { sandboxes: [] });

    await openForm(wrapper);
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('input[inputmode="numeric"]').setValue('990001');
    harness.raise = async () => {
        state.jobs = [{
                task: '990001',
                profile: 'demo-shop',
                action: 'up',
                state: 'running',
                index: 1,
                total: 11,
                label: 'Копируем код',
            }];
    };
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    await openForm(wrapper);
    assert.equal(wrapper.find('#sandboxes-create').isVisible(), true);
    assert.equal(wrapper.find('input[inputmode="numeric"]').element.value, '990001');
    wrapper.unmount();

    const afterDeletion = await mountSandboxes(t, { sandboxes: [entry()] });
    const nextWrapper = afterDeletion.wrapper;

    assert.equal(nextWrapper.find('#sandboxes-create').isVisible(), false);
    await openForm(nextWrapper);
    await nextWrapper.find('[role="switch"]').trigger('click');
    await nextWrapper.find('input[inputmode="numeric"]').setValue('12345');
    await nextWrapper.find('[aria-controls="sandboxes-create"]').trigger('click');
    afterDeletion.state.sandboxes = [];
    afterDeletion.state.jobs = [];
    await afterDeletion.flushPromises();
    await openForm(nextWrapper);
    assert.equal(nextWrapper.find('#sandboxes-create').isVisible(), true);
    assert.equal(nextWrapper.find('input[inputmode="numeric"]').element.value, '12345');
});
