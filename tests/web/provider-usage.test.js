import assert from 'node:assert/strict';
import test from 'node:test';

import {
  localizeUsageBar,
  localizeUsageResource,
  providerStatusHint,
  providerUsageView,
  resetAt,
  resetIn,
} from '../../web/src/features/providers/providerUsage.ts';
import {
  prepareUsageControl,
  usageControlConfirmation,
} from '../../web/src/features/providers/providerUsageActions.ts';

test('окна всех исполнителей имеют общие подписи в RU/EN, включая старые и именованные квоты', () => {
  const cases = [
    ['codex', 'codex:primary', 300, 'Сессия (5ч)', '5 часов', '5 hours'],
    ['codex', 'spark:primary', 300,
      'Сессия · Spark · резерв', '5 часов · Spark · резерв', '5 hours · Spark · резерв'],
    ['codex', 'codex:secondary', 10080, 'Неделя (7д)', 'Неделя', 'Week'],
    ['claude', 'session', null, 'Сессия (5ч)', '5 часов', '5 hours'],
    ['claude', 'five_hour', null, 'five hour', '5 часов', '5 hours'],
    ['claude', 'seven_day', null, 'seven day', 'Неделя', 'Week'],
    ['claude', 'weekly_scopedSonnet', null, 'Неделя · Sonnet', 'Неделя · Sonnet', 'Week · Sonnet'],
    ['kimi', 'kimi:1:5:hour', null, 'Сессия (5ч)', '5 часов', '5 hours'],
    ['kimi', 'kimi:4:5:hour', null, 'Сессия · код', '5 часов · код', '5 hours · код'],
    ['kimi', 'kimi:2:1:week', null, 'Неделя (7д)', 'Неделя', 'Week'],
    ['kimi', 'kimi:monthTotal', null, 'Месяц', 'Месяц', 'Month'],
    ['glm', 'zai:5h', 300, '5 часов', '5 часов', '5 hours'],
    ['glm', 'zai:week', 10080, 'Неделя', 'Неделя', 'Week'],
    ['glm', 'zai:mcp', null, 'MCP за месяц', 'MCP за месяц', 'Monthly MCP'],
  ];

  for (const [providerId, key, minutes, oldLabel, russian, english] of cases) {
    const source = {
      key,
      label: oldLabel,
      pct: 34,
      resetsAt: '2026-11-04T09:40:00.000Z',
      ...(minutes === null ? {} : { windowMinutes: minutes }),
    };
    const original = structuredClone(source);

    for (const [locale, label] of [['ru', russian], ['en', english]]) {
      const view = providerUsageView({
        state: 'ok',
        bars: [source],
      }, { id: providerId }, locale);
      const { separated, ...actual } = view.bars[0];

      assert.deepEqual(actual, {
        ...original,
        label,
      });
    }

    assert.deepEqual(source, original);
  }

  for (const [providerId, key] of [['custom', 'session'], ['kimi', 'kimi:3:2:day']]) {
    const bar = {
      key,
      windowMinutes: 300,
      label: 'Собственное окно',
    };

    assert.equal(localizeUsageBar(providerId, bar, 'ru'), bar);
    assert.equal(localizeUsageBar(providerId, bar, 'en'), bar);
  }
});

test('Новые месячные квоты Kimi переводятся без выдуманной длительности окна', () => {
  const bar = {
    key: 'kimi:monthTotal',
    label: 'Месяц',
    pct: 40,
    resetsAt: null,
  };
  const resource = {
    key: 'kimi-monthly-volume',
    label: 'Месячный объём',
    summary: 'Израсходовано за месяц: 40%',
    note: 'Из них код: 20% месячной квоты',
  };
  const translated = localizeUsageResource('kimi', resource, 'en');

  assert.equal(localizeUsageBar('kimi', bar, 'en').label, 'Month');
  assert.equal('windowMinutes' in localizeUsageBar('kimi', bar, 'en'), false);
  assert.equal(localizeUsageBar('kimi', {
    key: 'kimi:1:5:hour',
    label: 'Сессия (5ч)',
    pct: 0,
  }, 'en').label, '5 hours');
  assert.equal(translated.summary, 'Used this month: 40%');
  assert.equal(translated.note, 'Code accounts for 20% of the monthly quota');
  assert.deepEqual(localizeUsageBar('kimi', bar, 'ru'), bar);
});

test('Новые состояния доплаты переводятся на RU/EN без изменения данных и ссылок', () => {
  const cases = [
    {
      providerId: 'kimi',
      resource: {
        key: 'kimi-extra-usage',
        label: 'Extra Usage',
        summary: 'Не включено или не пополнено',
        controls: [{
          id: 'enable-kimi-usage',
          kind: 'link',
          label: 'Включить и пополнить в Kimi',
          href: 'https://www.kimi.com/code/console',
        }],
      },
      label: 'Extra Usage',
      summary: 'Not enabled or not funded',
      control: 'Enable and add funds in Kimi',
    },
    {
      providerId: 'kimi',
      resource: {
        key: 'kimi-monthly-volume',
        label: 'Месячный объём',
        summary: 'Kimi не сообщает остаток',
        controls: [{
          id: 'view-kimi-monthly-volume',
          kind: 'link',
          label: 'Посмотреть в Kimi',
          href: 'https://www.kimi.com/code/console',
        }],
      },
      label: 'Monthly volume',
      summary: 'Kimi does not report the remaining volume',
      control: 'View in Kimi',
    },
    {
      providerId: 'codex',
      resource: {
        key: 'chatgpt-credits',
        label: 'Дополнительные кредиты',
        summary: 'Нет данных о кредитах',
        controls: [{
          id: 'manage-credits',
          kind: 'link',
          label: 'Купить / управлять кредитами',
          href: 'https://chatgpt.com/codex/settings/usage',
        }],
      },
      label: 'Extra credits',
      summary: 'No credit data',
      control: 'Buy or manage credits',
    },
  ];

  for (const { providerId, resource, label, summary, control } of cases) {
    const source = structuredClone(resource);
    const english = localizeUsageResource(providerId, resource, 'en');

    assert.equal(english.label, label);
    assert.equal(english.summary, summary);
    assert.equal(english.controls[0].label, control);
    assert.equal(english.controls[0].href, resource.controls[0].href);
    assert.deepEqual(localizeUsageResource(providerId, resource, 'ru'), source);
    assert.deepEqual(resource, source);
  }

  const wallet = {
    key: 'kimi-extra-usage',
    kind: 'balance',
    balance: { amount: 12.5, currency: 'CNY' },
    summary: 'Баланс: ¥12.50',
    note: 'В этом месяце: ¥10.00 из ¥50.00.',
  };

  assert.deepEqual(localizeUsageResource('kimi', wallet, 'en'), wallet);
});

test('missing usage data has visible loading copy', () => {
  const view = providerUsageView(null, { name: 'Claude' });
  assert.equal(view.state, 'loading');
  assert.match(view.message, /ещё не получены/i);
  assert.deepEqual(view.bars, []);
});

test('popover freshness включается capability и сохраняет проценты истёкшего окна', () => {
  const entry = {
    state: 'ok',
    lastSuccessfulAt: 100_000,
    runtimeGeneration: 'runtime-1',
    pollIntervalMs: 300_000,
    bars: [{
      key: 'session',
      pct: 13,
      resetsAt: '1970-01-01T00:03:00.000Z',
    }],
  };
  const provider = { id: 'fixture', usagePresentation: { freshness: true, spentLabel: true } };
  const view = providerUsageView(entry, provider, 'ru', { now: 200_000 });

  assert.equal(view.stale, true);
  assert.equal(view.measuredAt, 100_000);
  assert.equal(view.bars[0].pct, 13);
  assert.equal(providerUsageView(entry, { id: 'managed-fixture' }, 'ru', { now: 200_000 }).stale, undefined);
});

test('auth failure offers claude login instead of an empty tooltip', () => {
  const view = providerUsageView({
    state: 'auth_required',
    bars: [],
    message: 'Сессия Claude истекла.',
    action: { kind: 'terminal', label: 'Войти в Claude', command: 'claude login' },
  }, { name: 'Claude' });
  assert.equal(view.tone, 'bad');
  assert.equal(view.action.command, 'claude login');
  assert.match(view.message, /истекла/i);
});

// Полосы прошлого удачного чтения остаются, а подписи «показываем последние успешно
// полученные значения» больше нет: над ней уже стоит «не удалось получить лимиты,
// повторим проверку», и вторая строка про то же занимала место, ничего не добавляя.
test('stale usage keeps bars without a line about their age', () => {
  const view = providerUsageView({
    state: 'unavailable',
    stale: true,
    bars: [{ key: 'weekly', label: 'Неделя', pct: 80 }],
    message: 'Anthropic временно не отвечает.',
  }, { name: 'Claude' });
  assert.equal(view.bars.length, 1);
  assert.equal(view.note, undefined);
});

test('unsupported provider usage is a normal explicit state', () => {
  const view = providerUsageView({
    state: 'unsupported',
    bars: [],
    message: 'Локальный ИИ не отдаёт данные о лимитах подписки.',
  }, { name: 'Локальный ИИ' });
  assert.equal(view.tone, 'muted');
  assert.match(view.message, /не отдаёт/i);
});

test('bucket boundary is drawn where the group changes, not per bar', () => {
  const view = providerUsageView({
    state: 'ok',
    bars: [
      { key: 'codex:primary', group: 'codex', label: 'Неделя (7д)', pct: 2 },
      { key: 'spark:primary', group: 'codex_spark', label: 'Сессия · Spark', pct: 0 },
      { key: 'spark:secondary', group: 'codex_spark', label: 'Неделя · Spark', pct: 0 },
      { key: 'reserve:primary', group: 'base_model_inference', label: 'Неделя · gpt-reserve', pct: 0 },
    ],
  }, { name: 'GPT (Codex)' });

  // Полосы одного ведра остаются слитными; линия появляется только на его границе,
  // и никогда — перед первой полосой.
  assert.deepEqual(view.bars.map((bar) => bar.separated), [false, true, false, true]);
});

test('an executor that never names a bucket keeps the flat list it had before', () => {
  // Справочные полосы описывают ресурсы, а не вёдра лимитов. Линия там утверждала бы
  // структуру, о которой исполнитель ничего не сообщал.
  const view = providerUsageView({
    state: 'ok',
    bars: [
      { key: 'vram', label: 'Видеопамять', pct: 80 },
      { key: 'ram', label: 'Оперативная память', pct: 10 },
    ],
  }, { name: 'Локальный ИИ' });

  assert.deepEqual(view.bars.map((bar) => bar.separated), [false, false]);
});

test('an unnamed bar neither breaks a bucket nor starts one', () => {
  const view = providerUsageView({
    state: 'ok',
    bars: [
      { key: 'a', group: 'codex', label: 'Неделя (7д)', pct: 2 },
      { key: 'b', label: 'Без ведра', pct: 0 },
      { key: 'c', group: 'codex', label: 'Сессия (5ч)', pct: 1 },
      { key: 'd', group: 'reserve', label: 'Неделя · gpt-reserve', pct: 0 },
    ],
  }, { name: 'GPT (Codex)' });

  assert.deepEqual(view.bars.map((bar) => bar.separated), [false, false, false, true]);
});

test('provider usage view keeps generic resources without knowing the vendor', () => {
  const resource = {
    key: 'kimi-balance',
    label: 'Баланс Kimi',
    summary: '12 CNY',
    controls: [{ id: 'top-up', kind: 'link', label: 'Пополнить', href: 'https://example.test' }],
  };
  const view = providerUsageView({
    state: 'ok',
    bars: [],
    resources: [resource],
  }, { name: 'Kimi' });

  assert.deepEqual(view.resources, [resource]);
});

test('generic usage controls build provider action payloads and confirmations', () => {
  const control = {
    id: 'limit',
    kind: 'number',
    action: 'configure-extra-usage',
    field: 'limit',
    unit: 'EUR',
    minExclusive: 0,
    confirm: {
      text: 'Поставить потолок {value} {unit}?',
      label: 'Поставить',
    },
  };

  assert.deepEqual(prepareUsageControl(control, '12,50'), {
    ok: true,
    actionId: 'configure-extra-usage',
    payload: { limit: 12.5 },
    value: 12.5,
  });
  assert.deepEqual(usageControlConfirmation(control, 12.5), {
    text: 'Поставить потолок 12.5 EUR?',
    label: 'Поставить',
    danger: false,
  });
  assert.equal(prepareUsageControl(control, '0').ok, false);

  const toggle = {
    kind: 'toggle',
    action: 'configure-auto-top-up',
    field: 'enabled',
    confirm: {
      on: { text: 'Включить?', label: 'Включить' },
      off: { text: 'Выключить?', label: 'Выключить', danger: true },
    },
  };
  assert.deepEqual(prepareUsageControl(toggle, false).payload, { enabled: false });
  assert.equal(usageControlConfirmation(toggle, false).danger, true);
});

// Окно сессии живёт пять часов: без минут подпись стоит на месте почти час подряд,
// и человек не понимает, ждать ему двадцать минут или полтора часа.
test('session reset shows minutes next to hours', () => {
  const now = Date.parse('2026-09-02T12:34:00Z');

  assert.equal(resetIn('2026-09-02T15:00:00Z', now), 'сброс через 2ч 26м');
  assert.equal(resetIn('2026-09-02T12:52:00Z', now), 'сброс через 18м');
  assert.equal(resetIn('2026-09-02T15:34:00Z', now), 'сброс через 3ч');
});

// Недельное ведро минутами не уточняется: на таком сроке они шум, а не сведения.
test('weekly reset stays in hours and days', () => {
  const now = Date.parse('2026-09-02T12:34:00Z');

  assert.equal(resetIn('2026-09-04T00:00:00Z', now), 'сброс через 35ч');
  assert.equal(resetIn('2026-09-06T00:00:00Z', now), 'сброс через 3д');
});

// «Сброс через 4д» не говорит, во сколько ждать окно: планировать по одному
// отсчёту нельзя, и календарный момент считается по местной полуночи.
test('reset copy also names the calendar moment', () => {
  const now = new Date(2026, 8, 2, 12, 34).getTime();

  assert.equal(resetAt(new Date(2026, 8, 2, 17, 33).toISOString(), now), 'сегодня 17:33');
  assert.equal(resetAt(new Date(2026, 8, 3, 3, 0).toISOString(), now), 'завтра 03:00');
  assert.equal(resetAt(new Date(2026, 8, 15, 3, 0).toISOString(), now), '15 сен 03:00');
});

// «Завтра» — следующая дата календаря, а не «через сутки»: сброс через 20 часов
// приходится то на завтра, то на послезавтра, и человек сверяется с календарём.
test('calendar day, not a 24-hour span, decides between today and tomorrow', () => {
  const lateEvening = new Date(2026, 8, 2, 23, 30).getTime();
  const earlyMorning = new Date(2026, 8, 2, 1, 0).getTime();
  const inTwentyHours = (from) => new Date(from + 20 * 3_600_000).toISOString();

  assert.match(resetAt(inTwentyHours(lateEvening), lateEvening), /^завтра /);
  assert.match(resetAt(inTwentyHours(earlyMorning), earlyMorning), /^сегодня /);
});

test('missing or passed reset date has no copy at all', () => {
  const now = Date.parse('2026-09-02T12:34:00Z');

  assert.equal(resetIn(null, now), '');
  assert.equal(resetIn('2026-09-02T12:00:00Z', now), '');
  assert.equal(resetAt(null, now), '');
  assert.equal(resetAt('2026-09-02T12:00:00Z', now), '');
  assert.equal(resetAt('не дата', now), '');
});

// Сбой у вендора выглядел как поломка GrigDesk: человек читал «не удалось получить
// лимиты» и шёл гадать в журналы вместо страницы состояния сервиса.
test('vendor fault points at the status page declared by the adapter', () => {
  const hint = providerStatusHint(
    { name: 'Claude', vendor: 'Anthropic', statusPage: 'https://status.claude.com' },
    { state: 'unavailable' },
  );

  assert.deepEqual(hint, {
    url: 'https://status.claude.com',
    host: 'status.claude.com',
    text: 'Причина может быть на стороне Anthropic — состояние сервиса:',
  });
});

// Главный вопрос человека — «это у меня или у них», и отвечает на него страница
// состояния, прочитанная сервером, а не поход по ссылке глазами.
test('vendor status page answers whether the fault is on their side', () => {
  const provider = { name: 'Claude', vendor: 'Anthropic', statusPage: 'https://status.claude.com' };
  const quiet = providerStatusHint(provider, {
    state: 'unavailable',
    vendorStatus: { state: 'ok', summary: 'All Systems Operational', components: [], incident: '' },
  });

  assert.match(quiet.text, /Anthropic о сбое не сообщает \(All Systems Operational\)/u);

  const broken = providerStatusHint(provider, {
    state: 'unavailable',
    vendorStatus: {
      state: 'down',
      summary: 'Major Service Outage',
      components: ['API'],
      incident: 'Elevated error rates',
    },
  });

  assert.match(broken.text, /Anthropic сообщает о сбое: Major Service Outage · API · «Elevated error rates»/u);
  assert.equal(broken.host, 'status.claude.com');
});

// Страница состояния бывает недоступна ровно тогда же, когда и сам вендор. Придумывать
// за неё «у них всё хорошо» нельзя — подсказка возвращается к «посмотри сам».
test('unread status page falls back to the plain link', () => {
  const provider = { name: 'Claude', vendor: 'Anthropic', statusPage: 'https://status.claude.com' };

  for (const vendorStatus of [undefined, { state: 'unknown', summary: '', components: [], incident: '' }]) {
    const hint = providerStatusHint(provider, { state: 'unavailable', vendorStatus });

    assert.match(hint.text, /Причина может быть на стороне Anthropic/u);
  }
});

// Своя беда чужой страницей не лечится: при истёкшей авторизации надо логиниться,
// при старом CLI — обновляться, и ссылка на состояние сервиса там только сбивает.
test('local trouble keeps the vendor status page out of the popover', () => {
  const provider = {
    name: 'Claude',
    vendor: 'Anthropic',
    statusPage: 'https://status.claude.com',
  };

  assert.equal(providerStatusHint(provider, { state: 'auth_required' }), null);
  assert.equal(providerStatusHint(provider, { state: 'unsupported' }), null);
  assert.equal(providerStatusHint(provider, { state: 'ok' }), null);
});

// Адрес объявляет адаптер. Локальный исполнитель его не объявляет — и выдумывать
// страницу состояния для демона на этой же машине фронт не вправе.
test('executor without a declared status page gets no invented address', () => {
  assert.equal(
    providerStatusHint({ name: 'Фейк', vendor: 'Фейк' }, { state: 'unavailable' }),
    null,
  );
});

test('W0: без измерения ручной режим объясняет действие вместо вечной загрузки', () => {
  const manual = providerUsageView(undefined, {}, 'ru', { manualOnly: true });
  const automatic = providerUsageView(undefined, {}, 'ru');

  assert.equal(manual.state, 'unavailable');
  assert.match(manual.message, /Квота ещё не проверялась.*↻/u);
  assert.deepEqual(manual.bars, []);
  assert.equal(manual.measuredAt, null);
  assert.equal(automatic.state, 'loading');
});
