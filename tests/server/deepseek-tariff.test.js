// Тариф DeepSeek считается в UTC, а человеку показывается абсолютная граница в зоне
// сервера. Фиксированные моменты и явные IANA-зоны не дают окружению менять ожидания.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEPSEEK_PRICING_URL,
  deepSeekTariffPhase,
  deepSeekTariffResource,
} from '../../server/src/lib/deepseek/tariff.ts';

test('полуоткрытые окна среды переключают фазу на точных UTC-границах', () => {
  const cases = [
    [0, 59, false, Date.UTC(2026, 8, 16, 1, 0)],
    [1, 0, true, Date.UTC(2026, 8, 16, 4, 0)],
    [3, 59, true, Date.UTC(2026, 8, 16, 4, 0)],
    [4, 0, false, Date.UTC(2026, 8, 16, 6, 0)],
    [9, 59, true, Date.UTC(2026, 8, 16, 10, 0)],
    [10, 0, false, Date.UTC(2026, 8, 17, 1, 0)],
  ];

  for (const [hour, minute, peak, until] of cases) {
    const phase = deepSeekTariffPhase(Date.UTC(2026, 8, 16, hour, minute));

    assert.equal(phase.peak, peak, `${hour}:${minute}`);
    assert.equal(phase.until, until, `${hour}:${minute}`);
    assert.equal(phase.holiday, false);
    assert.equal(phase.calendarCovered, true);
  }
});

test('после пятницы и на выходных скидка длится до пика понедельника', () => {
  const mondayPeak = Date.UTC(2026, 8, 21, 1, 0);
  const moments = [
    Date.UTC(2026, 8, 18, 12, 0),
    Date.UTC(2026, 8, 19, 0, 0),
    Date.UTC(2026, 8, 19, 23, 59),
    Date.UTC(2026, 8, 20, 0, 0),
    Date.UTC(2026, 8, 20, 23, 59),
  ];

  for (const now of moments) {
    const phase = deepSeekTariffPhase(now);

    assert.equal(phase.peak, false);
    assert.equal(phase.until, mondayPeak);
  }
});

test('праздники КНР пропускаются целиком до первого обычного буднего окна', () => {
  const nationalDay = deepSeekTariffPhase(Date.UTC(2026, 9, 1, 2, 0));
  assert.deepEqual(nationalDay, {
    peak: false,
    until: Date.UTC(2026, 9, 8, 1, 0),
    holiday: true,
    calendarCovered: true,
  });

  const springFestival = deepSeekTariffPhase(Date.UTC(2026, 1, 16, 2, 0));
  assert.deepEqual(springFestival, {
    peak: false,
    until: Date.UTC(2026, 1, 24, 1, 0),
    holiday: true,
    calendarCovered: true,
  });
});

test('за покрытием календаря неизвестные праздники не выдумываются', () => {
  const phase = deepSeekTariffPhase(Date.UTC(2027, 2, 3, 2, 0));

  assert.deepEqual(phase, {
    peak: true,
    until: Date.UTC(2027, 2, 3, 4, 0),
    holiday: false,
    calendarCovered: false,
  });
});

test('Новосибирск получает местные часы, ближайший будний день и полное расписание', () => {
  const peak = deepSeekTariffResource({
    now: Date.UTC(2026, 8, 16, 1, 0),
    timeZone: 'Asia/Novosibirsk',
  });
  assert.equal(peak.tone, 'warn');
  assert.equal(peak.summary, 'пик ×2 до 11:00');
  assert.equal(
    peak.note,
    'Пик по будням 08:00–11:00 и 13:00–17:00 '
      + '(01:00–04:00 и 06:00–10:00 UTC), кроме праздников КНР: вход и выход вдвое дороже; '
      + 'остальное время, выходные и праздники — скидка 50 %. Часы местные (UTC+7).',
  );

  const fridayEvening = deepSeekTariffResource({
    now: Date.UTC(2026, 8, 18, 12, 0),
    timeZone: 'Asia/Novosibirsk',
  });
  assert.equal(fridayEvening.tone, 'ok');
  assert.equal(fridayEvening.summary, 'скидка 50 % до пн 08:00');
});

test('получасовая зона сохраняет минуты в сводке, расписании и смещении', () => {
  const resource = deepSeekTariffResource({
    now: Date.UTC(2026, 8, 16, 1, 0),
    timeZone: 'Asia/Kolkata',
  });

  assert.equal(resource.summary, 'пик ×2 до 09:30');
  assert.match(resource.note, /06:30–09:30 и 11:30–15:30/u);
  assert.match(resource.note, /Часы местные \(UTC\+5:30\)\./u);
});

test('Нью-Йорк считает сегодня и завтра по местным датам, а не по UTC', () => {
  const sameLocalDate = deepSeekTariffResource({
    now: Date.UTC(2026, 8, 16, 22, 0),
    timeZone: 'America/New_York',
  });
  assert.equal(sameLocalDate.summary, 'скидка 50 % до 21:00');

  const localTomorrow = deepSeekTariffResource({
    now: Date.UTC(2026, 8, 16, 3, 0),
    timeZone: 'America/New_York',
  });
  assert.equal(localTomorrow.summary, 'пик ×2 до завтра 00:00');

  const weekendTomorrow = deepSeekTariffResource({
    now: Date.UTC(2026, 8, 19, 12, 0),
    timeZone: 'America/New_York',
  });
  assert.equal(weekendTomorrow.summary, 'скидка 50 % до завтра 21:00');
});

test('дальний переход показывает дату, а ресурс несёт праздник и ссылку на тарифы', () => {
  const resource = deepSeekTariffResource({
    now: Date.UTC(2026, 9, 1, 2, 0),
    timeZone: 'Asia/Novosibirsk',
  });

  assert.equal(resource.key, 'tariff');
  assert.equal(resource.label, 'Тариф');
  assert.equal(resource.tone, 'ok');
  assert.equal(resource.summary, 'скидка 50 % до 8 окт 08:00');
  assert.match(resource.note, / · сейчас праздник КНР$/u);
  assert.deepEqual(resource.controls, [{
    id: 'pricing',
    kind: 'link',
    label: 'Тарифы DeepSeek',
    href: DEEPSEEK_PRICING_URL,
  }]);
});

test('непокрытый год явно предупреждает о допущении календаря', () => {
  const resource = deepSeekTariffResource({
    now: Date.UTC(2027, 2, 3, 2, 0),
    timeZone: 'Asia/Novosibirsk',
  });

  assert.match(
    resource.note,
    / · календарь праздников КНР на 2027 не внесён, праздники считаются рабочими днями$/u,
  );
});

test('сверка со страницей цен: расхождение — беда с подробностями, остальное — тихая приписка', () => {
  const now = Date.UTC(2026, 8, 16, 1, 0);
  const HOUR = 3_600_000;
  const base = { now, timeZone: 'Asia/Novosibirsk' };

  const mismatch = deepSeekTariffResource({
    ...base,
    pricing: {
      kind: 'mismatch',
      at: now - HOUR,
      details: ['пик на сайте 01:00–04:00 и 06:00–11:00 UTC', 'в таблице цен пары не ×2: $0.15/$0.45'],
    },
  });
  assert.equal(mismatch.tone, 'bad');
  assert.equal(mismatch.summary, 'пик ×2 до 11:00');
  assert.equal(
    mismatch.note,
    'Страница тарифов DeepSeek говорит другое: пик на сайте 01:00–04:00 и 06:00–11:00 UTC; '
      + 'в таблице цен пары не ×2: $0.15/$0.45 — расписание в кокпите устарело, поправьте '
      + 'константы в server/src/lib/deepseek/tariff.ts. Пик по будням 08:00–11:00 и 13:00–17:00 '
      + '(01:00–04:00 и 06:00–10:00 UTC), кроме праздников КНР: вход и выход вдвое дороже; '
      + 'остальное время, выходные и праздники — скидка 50 %. Часы местные (UTC+7).',
  );

  const fresh = deepSeekTariffResource({ ...base, pricing: { kind: 'verified', at: now - 2 * HOUR } });
  assert.equal(fresh.tone, 'warn');
  assert.match(fresh.note, / · сверено с сайтом сегодня 06:00$/u);

  const yesterday = deepSeekTariffResource({ ...base, pricing: { kind: 'verified', at: now - 26 * HOUR } });
  assert.match(yesterday.note, / · сверено с сайтом вчера 06:00$/u);

  const stale = deepSeekTariffResource({ ...base, pricing: { kind: 'verified', at: now - 8 * 24 * HOUR } });
  assert.equal(stale.tone, 'warn');
  assert.match(stale.note, / · тарифы не сверялись с сайтом с 8 сен 08:00$/u);

  const unparsed = deepSeekTariffResource({ ...base, pricing: { kind: 'unparsed', at: now - HOUR } });
  assert.equal(unparsed.tone, 'warn');
  assert.match(unparsed.note, / · страница тарифов переверстана, расписание не сверить$/u);

  const unreachable = deepSeekTariffResource({
    ...base,
    pricing: { kind: 'unreachable', reason: 'ENOTFOUND' },
  });
  assert.match(unreachable.note, / · сайт тарифов недоступен, расписание не сверено$/u);
  assert.equal(unreachable.note.includes('ENOTFOUND'), false);

  // Приписка о сверке идёт после слов о празднике: сначала то, что влияет на цену сейчас.
  const holiday = deepSeekTariffResource({
    now: Date.UTC(2026, 9, 1, 2, 0),
    timeZone: 'Asia/Novosibirsk',
    pricing: { kind: 'verified', at: Date.UTC(2026, 9, 1, 1, 0) },
  });
  assert.match(holiday.note, / · сейчас праздник КНР · сверено с сайтом сегодня 08:00$/u);

  const silent = deepSeekTariffResource(base);
  assert.match(silent.note, /Часы местные \(UTC\+7\)\.$/u);
});
