// Фаза тарифа задаётся в UTC, подпись и расписание переводятся в зону сервера.
// Явные моменты и IANA-зоны сохраняют ожидания независимо от окружения тестов.
import assert from 'node:assert/strict';
import test from 'node:test';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 21, 6);
const TARIFF_MODULE = '../../server/src/lib/glm/tariff.ts';

test('полуоткрытое окно GLM и выходные', async () => {
  const { glmTariffPhase } = await import(TARIFF_MODULE);
  const cases = [
    ['2026-10-21T05:59:00Z', false, '2026-10-21T06:00:00Z'],
    ['2026-10-21T06:00:00Z', true, '2026-10-21T10:00:00Z'],
    ['2026-10-21T09:59:00Z', true, '2026-10-21T10:00:00Z'],
    ['2026-10-21T10:00:00Z', false, '2026-10-22T06:00:00Z'],
    ['2026-10-23T10:00:00Z', false, '2026-10-26T06:00:00Z'],
    ['2026-10-24T06:00:00Z', false, '2026-10-26T06:00:00Z'],
    ['2026-10-25T06:00:00Z', false, '2026-10-26T06:00:00Z'],
    ['2026-10-01T06:00:00Z', true, '2026-10-01T10:00:00Z'],
  ];

  for (const [moment, peak, until] of cases) {
    const actual = glmTariffPhase(Date.parse(moment));

    assert.equal(actual.peak, peak, moment);
    assert.equal(actual.until, Date.parse(until), moment);
  }
});

test('ресурс GLM: подписи, расписание и оба поколения', async () => {
  const { glmTariffResource } = await import(TARIFF_MODULE);
  const cases = [
    ['2026-10-21T05:59:00Z', 'вне пика до 13:00', 'ok'],
    ['2026-10-21T06:00:00Z', 'пик до 17:00', 'warn'],
    ['2026-10-21T10:00:00Z', 'вне пика до завтра 13:00', 'ok'],
    ['2026-10-23T10:00:00Z', 'вне пика до пн 13:00', 'ok'],
  ];

  for (const [moment, summary, tone] of cases) {
    const resource = glmTariffResource({ now: Date.parse(moment), timeZone: 'Asia/Novosibirsk' });

    assert.equal(resource.summary, summary);
    assert.equal(resource.tone, tone);
    assert.equal(resource.key, 'tariff');
    assert.equal(resource.label, 'Тариф');
    assert.match(resource.note, /13:00–17:00/u);
    assert.match(resource.note, /UTC\+7/u);
    assert.match(resource.note, /(?:пн–пт|понедельник.*пятниц)/u);
    assert.match(resource.note, /14:00–18:00/u);
    assert.match(resource.note, /(?:Сингапур|Singapore)/u);
    assert.match(resource.note, /UTC\+8/u);
    assert.match(resource.note, /06:00–10:00 UTC/u);
    assert.match(resource.note, /выходн.*Сингапур.*вне пика/iu);
    assert.match(resource.note, /0[,.]5\s*×/u);
    assert.match(resource.note, /1\s*×/u);
    assert.match(resource.note, /(?:×\s*2|вдвое|2 раза)/u);
    assert.match(resource.note, /GLM-5\.3.*1\s*×.*3\s*×/u);
    assert.match(resource.note, /GLM-5\.3-Flash.*0[,.]4\s*×.*1[,.]2\s*×/u);
    assert.match(resource.note, /(?:×\s*3|втрое|3 раза)/u);
    assert.deepEqual(resource.controls.map(({ kind, label, href }) => ({
      kind,
      label,
      href,
    })), [{
      kind: 'link',
      label: 'Тарифы Z.ai',
      href: 'https://docs.z.ai/devpack/overview',
    }]);
    assert.equal(Object.hasOwn(resource, 'balance'), false);
    assert.notEqual(resource.kind, 'balance');
    assert.equal(Object.hasOwn(resource, 'percent'), false);
  }
});

test('зона сервера меняет подпись, но не фазу', async () => {
  const { glmTariffResource } = await import(TARIFF_MODULE);
  const cases = [
    ['Asia/Kolkata', NOW, 'пик до 15:30', /11:30–15:30/u, /UTC\+5:30/u],
    ['America/New_York', NOW, 'пик до 06:00', /02:00–06:00/u, /UTC−4|UTC-4/u],
    ['America/New_York', Date.UTC(2026, 11, 2, 6), 'пик до 05:00', /01:00–05:00/u, /UTC−5|UTC-5/u],
  ];

  for (const [timeZone, now, summary, schedule, offset] of cases) {
    const resource = glmTariffResource({ now, timeZone });

    assert.equal(resource.summary, summary);
    assert.equal(resource.tone, 'warn');
    assert.match(resource.note, schedule);
    assert.match(resource.note, offset);
  }

  const honolulu = glmTariffResource({ now: NOW - 60_000, timeZone: 'Pacific/Honolulu' });

  assert.equal(honolulu.summary, 'вне пика до 20:00');
  assert.equal(honolulu.tone, 'ok');
  assert.match(honolulu.note, /20:00–00:00/u);
  assert.match(honolulu.note, /следующ|\+1/u);
  assert.match(honolulu.note, /(?:вс|воскресень).*?(?:чт|четверг)/u);
  assert.match(honolulu.note, /выходн.*Сингапур/iu);
  assert.doesNotMatch(honolulu.note, /местн.*воскресень.*целиком.*вне пика/iu);
});

/**
 * Статус источника содержит момент получения фактов и отдельную техническую причину.
 * Общий вид такой же у verified, unparsed и unreachable; агрегат задаётся сценарием.
 */
function pricingStatus(kind, at, { details = [], failure = null } = {}) {
  return {
    kind,
    at,
    details,
    sources: {
      overview: {
        kind,
        at,
        failure,
      },
      revision: {
        kind,
        at,
        failure,
      },
    },
  };
}

test('расхождения видны, технические статусы тихие', async () => {
  const { glmTariffResource } = await import(TARIFF_MODULE);
  const base = { now: NOW, timeZone: 'Asia/Novosibirsk' };
  const details = ['overview: конец пика на сайте 19:00', 'revision: GLM-5.3 peak 4×'];
  const mismatch = glmTariffResource({
    ...base,
    pricing: pricingStatus('mismatch', NOW - HOUR, { details }),
  });

  assert.equal(mismatch.tone, 'bad');
  assert.equal(mismatch.summary, 'пик до 17:00');
  assert.ok(mismatch.note.indexOf(details[0]) < mismatch.note.indexOf('13:00–17:00'));
  assert.match(mismatch.note, /устарел/u);

  for (const detail of details) {
    assert.ok(mismatch.note.includes(detail), detail);
  }

  const cases = [
    [pricingStatus('verified', NOW - HOUR), /сверен.*сегодня 12:00/u],
    [pricingStatus('verified', NOW - 26 * HOUR), /сверен.*вчера 11:00/u],
    [pricingStatus('verified', NOW - 7 * DAY), /сверен/u],
    [pricingStatus('verified', NOW - 7 * DAY - 1), /не сверял|старше|устарел/u],
    [pricingStatus('unparsed', NOW - HOUR), /переверстан|не разобран|не удалось разобрать/u],
    [pricingStatus('unreachable', null, { failure: 'ENOTFOUND' }), /недоступ/u],
  ];

  for (const [pricing, expectedNote] of cases) {
    const resource = glmTariffResource({ ...base, pricing });

    assert.equal(resource.tone, 'warn');
    assert.equal(resource.summary, 'пик до 17:00');
    assert.match(resource.note, expectedNote);
    assert.doesNotMatch(resource.summary, /сверен|недоступ|разобран|старше/u);
    assert.equal(resource.note.includes('ENOTFOUND'), false);
  }

  const exactWeek = glmTariffResource({ ...base, pricing: pricingStatus('verified', NOW - 7 * DAY) });

  assert.doesNotMatch(exactWeek.note, /не сверял|старше|устарел/u);

  for (const kind of ['unreachable', 'verified']) {
    const pricing = pricingStatus('mismatch', NOW - HOUR, { details });

    pricing.sources.revision = {
      kind,
      at: kind === 'verified' ? NOW - 8 * DAY : null,
      failure: kind === 'unreachable' ? 'ETIMEDOUT' : null,
    };

    const mixed = glmTariffResource({ ...base, pricing });

    assert.equal(mixed.tone, 'bad');
    assert.equal(mixed.summary, 'пик до 17:00');
    assert.doesNotMatch(mixed.note, /недоступ|не сверял|старше|ETIMEDOUT/u);

    for (const detail of details) {
      assert.ok(mixed.note.includes(detail), detail);
    }
  }

  const offPeak = glmTariffResource({
    ...base,
    now: NOW - 60_000,
    pricing: pricingStatus('unparsed', NOW - HOUR),
  });

  assert.equal(offPeak.tone, 'ok');
  assert.equal(offPeak.summary, 'вне пика до 13:00');
});
