import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTION,
     ROW,
     button,
     entry,
     mountSandboxes,
     pipelineSnapshot,
     rowOf,
     selectStand,
     } from './helpers/sandboxes-layout.js';
/**
 * Строки — наблюдаемая граница списка, одинаковая для реестра и идущего подъёма.
 * Проверка существования отделяет ожидаемый RED раскладки от ошибок доступа к DOM.
 */
function row(wrapper, task) {
    const found = rowOf(wrapper, task);

    assert.ok(Boolean(found), `В списке есть компактная строка t${task}`);

    return found;
}
/**
 * Фильтр проекта ищется среди фильтров, а не одноимённого поля формы подъёма.
 * Имя aria-label может меняться без привязки теста к словесной формулировке.
 */
function projectFilter(wrapper) {
    const found = wrapper.findAll('.sandboxes__filters select')
        .find((item) => item.attributes('aria-label') !== 'Какие стенды показать');

    assert.ok(Boolean(found), 'Есть отдельный фильтр по проекту');

    return found;
}

function statusFilter(wrapper) {
    return wrapper.find('select[aria-label="Какие стенды показать"]');
}

function tasksIn(wrapper) {
    return wrapper.findAll(ROW).map((item) => item.text().match(/\bt(\d+)\b/)?.[1]);
}
/**
 * Значение счётчика читается из подписи option, доступной человеку.
 * Все категории считаются по стендам раздела, а не по полному снимку конвейера.
 */
function counts(select) {
    return Object.fromEntries(select.findAll('option').map((item) => {
        const numbers = item.text().match(/\d+/g);

        assert.ok(Boolean(numbers), `Вариант «${item.text()}» содержит счётчик`);

        return [item.element.value, Number(numbers.at(-1))];
    }));
}
/**
 * Четыре стенда пересекают два профиля и все активные категории.
 * Задача без стенда намеренно присутствует в снимке и не увеличивает фасеты.
 */
function filterFixture() {
    const sandboxes = [
        entry({
            task: '11',
            owner: 'pipeline',
            actions: [ACTION]
        }),
        entry({
            task: '12',
            owner: 'pipeline',
            slot: 1
        }),
        entry({
            task: '13',
            profile: 'demo-tools',
            owner: 'pipeline',
            slot: 0
        }),
        entry({
            task: '14',
            profile: 'demo-tools',
            slot: null
        }),
    ];
    const tasks = sandboxes.map((stand) => ({
        task: stand.task,
        profile: stand.profile,
        title: `Название ${stand.task}`,
        daemonAlive: true,
    }));
    const snapshot = pipelineSnapshot([...tasks, { task: '999', title: 'Без стенда' }], {
        running: [{ task: '11' }, { task: '12' }, { task: '13' }, { task: '999' }],
        waiting: [{ task: '12', text: 'Принять план' }, { task: '13', text: 'Не это состояние' }],
        stalled: [{ task: '13', title: 'Нужно решение' }],
    });

    return { sandboxes, snapshot };
}

test('строки показывают задачу и состояние из общего снимка', async (t) => {
    const options = filterFixture();
    const extra = [
        entry({ task: '15', owner: 'pipeline' }),
        entry({ task: '16', owner: 'pipeline' }),
        entry({
            task: '17',
            owner: 'pipeline',
            fePort: null,
            slot: null
        }),
        entry({
            task: '18',
            owner: 'pipeline',
            profile: 'demo-shop'
        }),
        entry({
            task: '19',
            owner: 'manual',
            profile: 'demo-shop'
        }),
        entry({
            task: '20',
            owner: 'manual',
            profile: 'demo-tools'
        }),
    ];

    options.sandboxes.push(...extra);
    options.snapshot.tasks.push({
        task: '15',
        profile: 'demo-shop',
        title: 'Завершённая задача',
        result: 'done'
    }, {
        task: '16',
        profile: 'demo-shop',
        title: 'Архивная задача',
        readOnly: true,
        daemonAlive: true
    }, {
        task: '17',
        profile: 'demo-shop',
        title: 'Граф недоступен'
    }, {
        task: '18',
        profile: 'other',
        title: 'ЧУЖОЕ НАЗВАНИЕ'
    }, {
        task: '19',
        profile: 'demo-shop',
        title: 'Известная ручная задача'
    }, {
        task: '20',
        profile: 'demo-shop',
        title: 'ЧУЖОЕ РУЧНОЕ НАЗВАНИЕ'
    });
    options.snapshot.silent = [{ task: '12', text: 'BUILD: молчит 10 мин' }];
    options.snapshot.stalled.push({ task: '11', title: 'BUILD: нужен человек' });
    options.snapshot.waiting.push({ task: '11', text: 'Слабее аварии' });
    options.snapshot.running.push({ task: '16' });
    options.snapshot.observedByTask['15'] = {
        gateKnown: true,
        result: 'done',
        daemon: 'stopped'
    };
    options.snapshot.observedByTask['16'] = { gateKnown: true, daemon: 'running' };
    options.snapshot.observedByTask['17'] = { gateKnown: false, daemon: 'stopped' };

    const { wrapper, harness, flushPromises } = await mountSandboxes(t, options);

    assert.equal(wrapper.findAll(ROW).length, 10, 'У каждого стенда одна компактная строка');
    assert.match(row(wrapper, '11').text(), /Название 11/);
    assert.match(row(wrapper, '11').text(), /Слот 0/i);
    assert.match(row(wrapper, '11').text(), /5190/);
    assert.match(row(wrapper, '11').text(), /Встал/i);
    assert.match(row(wrapper, '12').text(), /Молчит/i);
    assert.match(row(wrapper, '13').text(), /Встал/i);
    assert.match(row(wrapper, '14').text(), /Ручной/i);
    assert.match(row(wrapper, '15').text(), /Неактивен/i);
    assert.match(row(wrapper, '16').text(), /Неактивен/i);
    assert.match(row(wrapper, '17').text(), /Состояние неизвестно/);
    assert.doesNotMatch(row(wrapper, '17').text(), /Слот 0|:0\b/);
    assert.doesNotMatch(row(wrapper, '18').text(), /ЧУЖОЕ/);
    assert.match(row(wrapper, '19').text(), /Известная ручная задача/);
    assert.match(row(wrapper, '19').text(), /Ручной/);
    assert.doesNotMatch(row(wrapper, '20').text(), /ЧУЖОЕ/);
    harness.snapshot.value = { ...options.snapshot, error: 'Источник недоступен' };
    await flushPromises();
    assert.match(row(wrapper, '11').text(), /Название 11/);
    assert.match(wrapper.text(), /устарел|устарев|Источник недоступен/i);
    harness.snapshot.value = pipelineSnapshot([], { loadedAt: 0 });
    await flushPromises();
    assert.match(row(wrapper, '11').text(), /Состояние неизвестно/);
});
test('профили состояния поиск и счётчики согласованы', async (t) => {
    const { wrapper, state, flushPromises } = await mountSandboxes(t, filterFixture());
    const project = projectFilter(wrapper);
    const status = statusFilter(wrapper);
    const search = wrapper.find('[aria-label="Поиск стенда"]');

    assert.deepEqual(counts(project), {
        all: 4,
        'demo-shop': 2,
        'demo-tools': 2
    });

    const initial = counts(status);

    assert.equal(initial.all, 4);
    assert.equal(initial.pipeline, 3);
    assert.equal(initial.running, 1);
    assert.equal(initial.waiting, 1);
    assert.equal(initial.error, 1);
    assert.equal(initial.manual, 1);
    assert.equal(['running', 'waiting', 'error', 'manual', 'inactive', 'unknown']
        .reduce((sum, key) => sum + (initial[key] || 0), 0), initial.all);
    await project.setValue('demo-shop');
    assert.deepEqual(tasksIn(wrapper), ['11', '12']);
    assert.equal(counts(status).error, 0);
    assert.equal(counts(project)['demo-tools'], 2);
    await status.setValue('error');
    assert.deepEqual(tasksIn(wrapper), []);
    assert.equal(counts(project)['demo-shop'], 0);
    assert.equal(counts(project)['demo-tools'], 1);
    assert.equal(counts(status).waiting, 1);
    await button(wrapper, 'Сбросить').trigger('click');

    for (const query of [' НазВаНие 11 ', '11', 't11', 'demo-shop', 'backend',
        'task-990001', '/workspace/backend/t990001']) {
        await search.setValue(query);
        assert.ok(tasksIn(wrapper).includes('11'), `Поиск по ${query}`);
    }

    await search.setValue('Название 11');
    assert.deepEqual(tasksIn(wrapper), ['11']);
    assert.equal(counts(project)['demo-tools'], 0);
    assert.equal(counts(status).all, 1);
    await search.setValue('нет такого стенда');
    assert.deepEqual(tasksIn(wrapper), []);
    assert.equal(counts(status).all, 0);
    assert.match(wrapper.text(), /Подходящих стендов нет/);
    await button(wrapper, 'Сбросить').trigger('click');
    await project.setValue('demo-tools');
    state.sandboxes = state.sandboxes.filter((stand) => stand.profile === 'demo-shop');
    await flushPromises();
    assert.equal(project.element.value, 'all');
    assert.deepEqual(tasksIn(wrapper), ['11', '12']);
});
test('группы разделяют слоты и сохраняют числовой порядок', async (t) => {
    const sandboxes = [
        entry({ task: '1000000000000000001', slot: null }),
        entry({ task: '10', slot: 1 }),
        entry({ task: '2', slot: 0 }),
        entry({ task: '1000000000000000000', slot: null }),
        entry({
            task: '3',
            profile: 'demo-tools',
            slot: 0
        }),
        entry({
            task: '1',
            profile: null,
            slot: null
        }),
    ];
    const before = structuredClone(sandboxes);
    const { wrapper, state } = await mountSandboxes(t, { sandboxes });

    assert.deepEqual(tasksIn(wrapper), ['2', '10', '1000000000000000000', '1000000000000000001', '3', '1']);

    const group = row(wrapper, '2').element.closest('section');
    const other = row(wrapper, '3').element.closest('section');

    assert.ok(Boolean(group && other && group !== other), 'Два slot0 принадлежат разным группам');
    assert.match(group.textContent, /demo-shop/);
    assert.match(other.textContent, /demo-tools/);
    assert.match(wrapper.text(), /Без профиля/);
    assert.deepEqual(JSON.parse(JSON.stringify(state.sandboxes)), before);
    await wrapper.find('[aria-label="Поиск стенда"]').setValue('t2');

    const header = row(wrapper, '2').element.closest('section');

    assert.match(header.textContent,
        /слот[ыов]*[^\n]*0[^\n]*1/i,
        'Слот 1 остаётся занят даже когда его строка скрыта поиском');
});
test('выбор переживает замену объектов а исчезнувший очищается', async (t) => {
    const options = filterFixture();
    const { wrapper, harness, state, flushPromises } = await mountSandboxes(t, options);

    row(wrapper, '12');
    await selectStand(wrapper, '12');
    assert.equal(wrapper.findAll('.sandbox-card').length, 1);
    assert.match(wrapper.find('.sandbox-card').text(), /Название 12/);
    await statusFilter(wrapper).setValue('waiting');
    state.sandboxes = [...state.sandboxes].reverse().map((stand) => ({ ...stand }));
    state.jobs = [{
            task: '12',
            action: 'run',
            state: 'done',
            message: 'Обновлённый итог'
        }];
    harness.snapshot.value = {
        ...options.snapshot,
        waiting: [],
        running: [{ task: '12' }]
    };
    await flushPromises();
    assert.match(wrapper.find('.sandbox-card').text(), /Название 12/);
    assert.match(wrapper.find('.sandbox-card').text(), /Обновлённый итог/);
    assert.match(wrapper.text(), /Выбранный стенд вне фильтра/);
    await statusFilter(wrapper).setValue('manual');
    assert.match(wrapper.find('.sandbox-card h3').text(), /14/);
    state.sandboxes = state.sandboxes.filter((stand) => stand.task !== '14');
    await flushPromises();
    assert.equal(wrapper.findAll('.sandbox-card').length, 0);
    await statusFilter(wrapper).setValue('all');
    await selectStand(wrapper, '12');
    state.sandboxes = state.sandboxes.filter((stand) => stand.task !== '12');
    await flushPromises();
    assert.equal(wrapper.findAll('.sandbox-card').length, 1);
    assert.doesNotMatch(wrapper.find('.sandbox-card h3').text(), /12/);
});
test('давность различает подъём запись и неизвестное время', async (t) => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const week = 7 * 24 * 60 * 60 * 1000;
    const iso = (age) => new Date(now - age).toISOString();

    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });

    const { wrapper, harness, flushPromises } = await mountSandboxes(t, {
        sandboxes: [
            entry({ task: '1', updatedAt: iso(week - 1) }),
            entry({ task: '2', updatedAt: iso(week) }),
            entry({ task: '3', updatedAt: iso(24 * 60 * 60 * 1000) }),
            entry({ task: '4', updatedAt: iso(2 * week) }),
            entry({ task: '5', updatedAt: null }),
            entry({ task: '6', updatedAt: 'не дата' }),
            entry({ task: '7', updatedAt: iso(-week) }),
            entry({ task: '8', updatedAt: iso(2 * week) }),
            entry({ task: '9', updatedAt: iso(2 * week) }),
        ],
        jobs: [
            {
                task: '3',
                profile: 'demo-shop',
                action: 'up',
                state: 'done',
                startedAt: iso(week)
            },
            {
                task: '4',
                action: 'run',
                state: 'done',
                startedAt: iso(1000)
            },
            {
                task: '8',
                action: 'down',
                state: 'failed',
                startedAt: iso(1000)
            },
            {
                task: '9',
                profile: 'other',
                action: 'up',
                state: 'done',
                startedAt: iso(1000)
            },
        ],
    });

    assert.match(row(wrapper, '2').text(), /≈.*7\s*дн/);
    assert.match(row(wrapper, '3').text(), /7\s*дн/);
    assert.doesNotMatch(row(wrapper, '3').text(), /≈/);
    assert.match(row(wrapper, '4').text(), /≈.*14\s*дн/);
    assert.match(row(wrapper, '8').text(), /≈.*14\s*дн/);
    assert.match(row(wrapper, '9').text(), /≈.*14\s*дн/);

    for (const task of ['5', '6', '7']) {
        assert.match(row(wrapper, task).text(), /давность неизвестна/i);
    }

    const estimate = row(wrapper, '2').findAll('[data-ui-tooltip]')
        .map((item) => item.attributes('data-ui-tooltip')).join(' ');

    assert.match(estimate, /Оценка по обновлению записи о стенде; точная дата подъёма неизвестна/);
    assert.notEqual(row(wrapper,
        '1').classes().filter((name) => name !== 'is-pressed').join(' '),
        row(wrapper,
        '2').classes().filter((name) => name !== 'is-pressed').join(' '),
        'Семь суток — граница визуального выделения');
    assert.equal(row(wrapper, '5').attributes('class'), row(wrapper, '7').attributes('class'));

    const calls = JSON.stringify(harness.calls);

    t.mock.timers.tick(60000);
    await flushPromises();
    assert.equal(row(wrapper,
        '1').classes().filter((name) => name !== 'is-pressed').join(' '),
        row(wrapper,
        '2').classes().filter((name) => name !== 'is-pressed').join(' '));
    assert.equal(JSON.stringify(harness.calls), calls, 'Тик часов не вызывает операций');
    wrapper.unmount();
    t.mock.timers.tick(60000);
    assert.equal(JSON.stringify(harness.calls), calls);
});
test('подробности содержат полное имя переходы прогоны журнал и папки', async (t) => {
    const fullTitle = 'Полное название задачи '.repeat(12).trim();
    const stand = entry({
        owner: 'pipeline',
        removable: false,
        removableReason: 'pipeline_owned',
        actions: [{ ...ACTION, args: [] }]
    });
    const { wrapper, harness, state, flushPromises } = await mountSandboxes(t, {
        sandboxes: [stand, entry({ task: '990002' })],
        snapshot: pipelineSnapshot([{
                task: stand.task,
                profile: stand.profile,
                title: fullTitle
            }], {
            waiting: [{ task: stand.task, text: 'Принять результат' }],
        }),
        jobs: [{
                task: stand.task,
                action: 'run',
                state: 'done',
                message: 'Проверка завершена'
            }],
    });

    row(wrapper, stand.task);
    await selectStand(wrapper, stand.task);

    const card = wrapper.find('.sandbox-card');

    assert.ok(card.text().includes(fullTitle));
    assert.match(card.text(), /Ждёт решения/);
    assert.match(card.text(), /Принять результат/);

    const link = card.findAll('a').find((item) => item.text().includes('Открыть задачу'));

    assert.ok(Boolean(link), 'Есть переход к задаче');
    assert.equal(link.attributes('href'), '#/sandboxes?openTask=990001');
    assert.equal(card.find('a[aria-label="Открыть сайт стенда t990001"]').attributes('href'),
        'http://grigdesk.test:5190/');
    assert.ok(card.findAll('a').some((item) => item.attributes('href') === 'http://grigdesk.test:8090/'));
    assert.match(card.text(), /Порты отвечают/);

    const run = button(card, ACTION.label);

    assert.equal(run.attributes('data-ui-tooltip'), ACTION.description);
    assert.equal(card.findAll('p').some((item) => item.text() === ACTION.description), false);
    assert.match(card.text(), /Проверка завершена/);
    await run.trigger('click');
    await flushPromises();
    assert.equal(harness.confirmations.at(-1).text,
        `Проверить стенд на стенде t990001?\n\n${ACTION.confirm}`);
    await button(card, 'Журнал задания').trigger('click');
    await flushPromises();
    assert.match(card.text(), /ИТОГ: проверка успешна/);
    await card.find('details.sandbox-card__details summary').trigger('click');
    await card.find('[aria-label="Копировать путь"]').trigger('click');
    await flushPromises();
    assert.deepEqual(harness.copied, ['/workspace/backend/t990001']);
    assert.equal(card.find('.sandbox-card__removal').exists(), false);
    assert.match(card.text(), /сносится из карточки задачи/);
    state.busyTasks = [stand.task];
    await flushPromises();
    assert.equal(button(card, ACTION.label).attributes('aria-disabled'), 'true');
    state.jobs = [{
            task: stand.task,
            action: 'run',
            state: 'failed',
            message: 'Ошибка проверки'
        }];
    await flushPromises();
    assert.match(card.text(), /Ошибка проверки/);
    state.sandboxes = state.sandboxes.map((item) => item.task === stand.task
        ? { ...item, standAlive: false }
        : item);
    await flushPromises();
    assert.match(card.text(), /Порты не отвечают/);
    state.sandboxes = state.sandboxes.map((item) => item.task === stand.task
        ? { ...item, standAlive: null }
        : item);
    await flushPromises();
    assert.match(card.text(), /Не проверен/);
    assert.doesNotMatch(card.text(), /Порты не отвечают/);
    await selectStand(wrapper, '990002');
    assert.equal(wrapper.find('.sandbox-card').findAll('a')
        .some((item) => item.attributes('href')?.includes('openTask')),
        false);
});
test('подъём сразу становится строкой и сливается с реестром', async (t) => {
    const pending = {
        task: '990001',
        profile: 'demo-shop',
        action: 'up',
        state: 'running',
        index: 1,
        total: 11,
        label: 'Копируем код',
        startedAt: '2026-10-23T10:00:00Z'
    };
    const { wrapper, state, flushPromises } = await mountSandboxes(t, { sandboxes: [], jobs: [pending] });

    assert.equal(wrapper.findAll(ROW).length, 1, 'Идущий подъём виден до env');
    assert.match(row(wrapper, pending.task).text(), /1\/11 · Копируем код/);
    await selectStand(wrapper, pending.task);
    assert.equal(wrapper.find('.sandbox-card').exists(), false);
    assert.equal(wrapper.findAll('a').some((item) => /:5190|:8090/.test(item.attributes('href'))), false);
    assert.equal(wrapper.findAll('button').some((item) => /Снести/.test(item.text())), false);
    assert.doesNotMatch(row(wrapper, pending.task).text(), /Слот 0|:0\b/);
    state.jobs = [{
            ...pending,
            index: 2,
            label: 'Готовим окружение'
        }];
    await flushPromises();
    assert.match(row(wrapper, pending.task).text(), /2\/11 · Готовим окружение/);
    state.sandboxes = [entry({
            fePort: null,
            apiPort: null,
            slot: null,
            removable: false,
            removableReason: 'job_running'
        })];
    await flushPromises();
    assert.equal(wrapper.findAll(ROW).length, 1);
    assert.equal(row(wrapper, pending.task).attributes('aria-pressed'), 'true');
    assert.equal(wrapper.findAll('.sandbox-card').length, 1);
    state.sandboxes = [];
    state.jobs = [{
            ...pending,
            state: 'failed',
            message: 'Нет свободного слота'
        }];
    await flushPromises();
    assert.equal(wrapper.findAll(ROW).length, 0);
    assert.match(wrapper.find('.sandboxes__jobs').text(), /Нет свободного слота/);
});
test('форма справа сохраняет выбор и ввод', async (t) => {
    const { wrapper, harness, state, flushPromises } = await mountSandboxes(t, filterFixture());

    row(wrapper, '12');
    await selectStand(wrapper, '12');
    await wrapper.find('[aria-controls="sandboxes-create"]').trigger('click');

    const formElement = wrapper.find('form').element;

    await wrapper.find('form select').setValue('demo-tools');
    await wrapper.find('[role="switch"]').trigger('click');
    await wrapper.find('input[inputmode="numeric"]').setValue('12345');
    await wrapper.find('[aria-controls="sandboxes-create"]').trigger('click');
    assert.match(wrapper.find('.sandbox-card').text(), /Название 12/);
    state.sandboxes = state.sandboxes.map((stand) => ({ ...stand }));
    await flushPromises();
    await wrapper.find('[aria-controls="sandboxes-create"]').trigger('click');
    assert.equal(wrapper.find('form').element === formElement, true);
    assert.equal(wrapper.find('form select').element.value, 'demo-tools');
    assert.equal(wrapper.find('input[inputmode="numeric"]').element.value, '12345');
    harness.confirmed = false;
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    assert.equal(wrapper.find('#sandboxes-create').isVisible(), true);
    harness.confirmed = true;
    harness.raise = async () => {
        state.jobs = [{
                task: '12345',
                profile: 'demo-tools',
                action: 'up',
                state: 'running',
                index: 1,
                total: 11,
                label: 'Копируем код'
            }];
    };
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    assert.equal(wrapper.find('#sandboxes-create').isVisible(), false);
    assert.match(wrapper.find('.sandbox-card').text(), /Название 12/);
    row(wrapper, '12345');
    await wrapper.find('[aria-controls="sandboxes-create"]').trigger('click');
    assert.equal(wrapper.find('input[inputmode="numeric"]').element.value, '12345');
});
test('недавние задания свёрнуты и не зависят от фильтров', async (t) => {
    const { wrapper } = await mountSandboxes(t, {
        ...filterFixture(),
        jobs: [{
                task: '999',
                action: 'up',
                state: 'failed',
                message: 'Нет свободного слота'
            }],
    });
    const recent = wrapper.findAll('details').find((item) => item.text().includes('Недавние задания'));

    assert.ok(Boolean(recent), 'Недавние задания находятся в details');
    assert.equal(recent.attributes('open'), undefined);
    assert.match(recent.find('summary').text(), /Недавние задания.*1/);
    assert.match(recent.text(), /Нет свободного слота/);
    await statusFilter(wrapper).setValue('manual');
    await wrapper.find('[aria-label="Поиск стенда"]').setValue('нет совпадений');
    assert.match(recent.text(), /Нет свободного слота/);
    assert.equal(recent.attributes('open'), undefined);
});
test('реестровый стенд с идущим подъёмом показывает шаг в строке', async (t) => {
    const job = {
        task: '990002',
        action: 'up',
        state: 'running',
        index: 4,
        total: 11,
        label: 'Копируем базу данных'
    };
    const { wrapper, state, flushPromises } = await mountSandboxes(t, {
        sandboxes: [entry({
                task: job.task,
                fePort: null,
                apiPort: null,
                removable: false,
                removableReason: 'job_running'
            })],
        jobs: [job],
    });

    assert.match(row(wrapper, job.task).text(), /4\/11 · Копируем базу данных/);
    state.jobs = [{
            ...job,
            index: 5,
            label: 'Поднимаем контейнеры'
        }];
    await flushPromises();
    assert.match(row(wrapper, job.task).text(), /5\/11 · Поднимаем контейнеры/);
    state.jobs = [{ ...job, state: 'done' }];
    await flushPromises();
    assert.doesNotMatch(row(wrapper, job.task).text(), /4\/11|Копируем базу данных/);
});
