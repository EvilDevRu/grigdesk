// Страница состояния вендора как источник ответа «это у меня или у них». Смысл проверки:
// признанный сбой обязан доехать словами сервиса, а НЕпрочитанная страница не имеет права
// превратиться в «у них всё хорошо» — иначе подсказка врала бы уверенно.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderStatusProbe,
  parseStatuspageSummary,
  VENDOR_FAULT_USAGE_STATES,
} from '../../server/src/lib/providerStatus.ts';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return data; } };
}

test('признанный сбой приходит словами сервиса, а не нашей догадкой', () => {
  const parsed = parseStatuspageSummary({
    status: { indicator: 'major', description: 'Partial System Outage' },
    components: [
      { name: 'Группа', group: true, status: 'degraded_performance' },
      { name: 'API', status: 'partial_outage' },
      { name: 'Console', status: 'operational' },
      { name: 'Workbench', status: 'degraded_performance' },
    ],
    incidents: [{ name: 'Elevated error rates on API' }],
  });

  assert.equal(parsed.state, 'down');
  assert.equal(parsed.summary, 'Partial System Outage');
  assert.deepEqual(parsed.components, ['API', 'Workbench'], 'контейнер группы — не отдельная беда');
  assert.equal(parsed.incident, 'Elevated error rates on API');
});

test('спокойная страница и обслуживание — разные состояния', () => {
  assert.equal(parseStatuspageSummary({
    status: { indicator: 'none', description: 'All Systems Operational' },
  }).state, 'ok');
  assert.equal(parseStatuspageSummary({
    status: { indicator: 'minor', description: 'Degraded Performance' },
  }).state, 'degraded');
  assert.equal(parseStatuspageSummary({
    status: { indicator: 'maintenance', description: 'Scheduled Maintenance' },
  }).state, 'degraded');
});

test('незнакомая форма страницы не выдаёт себя за факт о сервисе', () => {
  assert.equal(parseStatuspageSummary({ ok: true }), null);
  assert.equal(parseStatuspageSummary(null), null);
  assert.equal(parseStatuspageSummary({ status: { indicator: 'всё хорошо' } }), null);
});

test('внешний текст обрезается и лишается переводов строк', () => {
  const parsed = parseStatuspageSummary({
    status: { indicator: 'minor', description: `${'сбой '.repeat(60)}\n\nвторая строка` },
    components: [{ name: 'A\nB', status: 'partial_outage' }],
    incidents: [{ name: 'x'.repeat(200) }],
  });

  assert.equal(parsed.summary.length, 120);
  assert.doesNotMatch(parsed.summary, /\n/u);
  assert.deepEqual(parsed.components, ['A B']);
  assert.equal(parsed.incident.length, 120, 'заголовок инцидента не длиннее своего предела');
  assert.match(parsed.incident, /…$/u, 'обрезанный заголовок помечен многоточием');
});

test('заголовок инцидента режется по границе слова, а не посреди него', () => {
  const name = `${'Users in APAC region may face increased error in ChatGPT '.repeat(3)}and Codex Cloud`;
  const parsed = parseStatuspageSummary({
    status: { indicator: 'minor', description: 'Partial System Degradation' },
    incidents: [{ status: 'investigating', name }],
  });

  const kept = parsed.incident.slice(0, -1);

  assert.match(parsed.incident, /…$/u);
  assert.ok(name.startsWith(kept), 'показанное — начало настоящего заголовка');
  assert.equal(name[kept.length], ' ', 'следующий символ оригинала — пробел, слово не разрезано');
});

// Главная беда подсказки была не в разборе, а в доверии одному числу: страница уже показывала
// человеку баннер инцидента, а сводный индикатор ещё стоял на `none` — и GrigDesk уверенно
// сообщал «вендор о сбое не сообщает» в самый разгар этого сбоя.
test('открытый инцидент перевешивает спокойный индикатор страницы', () => {
  const parsed = parseStatuspageSummary({
    status: { indicator: 'none', description: 'All Systems Operational' },
    components: [{ name: 'Codex Web', status: 'degraded_performance' }],
    incidents: [{ status: 'investigating', name: 'Users in APAC region may face increased error' }],
  });

  assert.equal(parsed.state, 'degraded', 'своё же свидетельство страницы весит больше её рол-апа');
  assert.equal(parsed.summary, '', 'спокойная сводка рядом с «сообщает о сбое» отрицала бы сама себя');
  assert.deepEqual(parsed.components, ['Codex Web']);
  assert.equal(parsed.incident, 'Users in APAC region may face increased error');
});

test('закрытый инцидент состояния не поднимает', () => {
  const parsed = parseStatuspageSummary({
    status: { indicator: 'none', description: 'All Systems Operational' },
    incidents: [{ status: 'resolved', name: 'Elevated error rates on API' }],
  });

  assert.equal(parsed.state, 'ok');
  assert.equal(parsed.summary, 'All Systems Operational');
  assert.equal(parsed.incident, '', 'история сбоя не выдаётся за текущий сбой');
});

test('страница читается один раз на кэш, а не на каждый отказ лимитов', async () => {
  const calls = [];
  const probe = createProviderStatusProbe({
    now: () => 1000,
    async fetchImpl(url) {
      calls.push(url);
      return jsonResponse({ status: { indicator: 'none', description: 'All Systems Operational' } });
    },
  });

  const first = await probe.read('https://status.example.test');
  const second = await probe.read('https://status.example.test/');

  assert.equal(first.state, 'ok');
  assert.equal(first.url, 'https://status.example.test/');
  assert.deepEqual(second, first);
  assert.deepEqual(calls, ['https://status.example.test/api/v2/summary.json'],
    'второй отказ лимитов сходил на страницу состояния заново');
});

test('моргнувшая сеть до страницы состояния лечится повтором с паузой', async () => {
  const pauses = [];
  let attempt = 0;
  const probe = createProviderStatusProbe({
    sleep: async (ms) => { pauses.push(ms); },
    async fetchImpl() {
      attempt += 1;

      if (attempt === 1) {
        throw new Error('socket hang up');
      }

      return jsonResponse({ status: { indicator: 'minor', description: 'Degraded Performance' } });
    },
  });

  const status = await probe.read('https://status.example.test');

  assert.equal(status.state, 'degraded');
  assert.equal(attempt, 2);
  assert.deepEqual(pauses, [400], 'мгновенный повтор попал бы в то же моргание');
});

test('недоступная страница остаётся неизвестностью, а не «у них всё хорошо»', async () => {
  const probe = createProviderStatusProbe({
    sleep: async () => {},
    async fetchImpl() { return jsonResponse({}, { ok: false, status: 503 }); },
  });

  const status = await probe.read('https://status.example.test');

  assert.equal(status.state, 'unknown');
  assert.equal(status.summary, '');
  assert.deepEqual(status.components, []);
});

test('не-https адрес не читается вовсе', async () => {
  const probe = createProviderStatusProbe({
    async fetchImpl() { throw new Error('ходить туда нельзя'); },
  });

  assert.equal(await probe.read('http://status.example.test'), null);
  assert.equal(await probe.read(''), null);
});

test('страницу состояния спрашивают только у беды на стороне сервиса', () => {
  assert.ok(VENDOR_FAULT_USAGE_STATES.has('unavailable'));
  assert.ok(VENDOR_FAULT_USAGE_STATES.has('blocked'));
  assert.ok(VENDOR_FAULT_USAGE_STATES.has('rate_limited'));
  assert.ok(!VENDOR_FAULT_USAGE_STATES.has('auth_required'), 'логин чужой страницей не лечится');
  assert.ok(!VENDOR_FAULT_USAGE_STATES.has('unsupported'));
  assert.ok(!VENDOR_FAULT_USAGE_STATES.has('ok'));
});
