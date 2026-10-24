import assert from 'node:assert/strict';
import test from 'node:test';

import { bootstrapStall, detectStall } from '../../server/src/lib/stall.ts';

const cases = [
  ['no-progress', 'BUILD: маршрут остановлен: no-progress — повтор набора: button',
    'исправления не сняли замечания', { what: /повтор набора: button/ }],
  ['rewind-limit', 'BUILD: маршрут остановлен: rewind-limit', 'исчерпан лимит возвратов',
    { cause: /замечани|наход|этап/i }],
  ['loop-ceiling', 'BUILD: маршрут остановлен: loop-ceiling', 'исчерпан лимит кругов',
    { action: /лимит|потолок|PROFILE_LOOP_MAX_ROUNDS/i }],
  ['сторож', 'TESTS: маршрут остановлен: human — сторож отверг сдачу — неверный manifest',
    'проверка не приняла результат', { what: /неверный manifest/, cause: /сдач|охват|сторож|проверк/i }],
  ['exhausted', 'SHIP: маршрут остановлен: human — исчерпан бюджет повторов: '
    + '3 захода без результата, последний — unknown', 'агент не вернул результат',
    { cause: /врем|провайдер/i, retained: /если.*черновик|черновик.*если/i }],
  ['human', 'BUILD: маршрут остановлен: human', 'нужно решение человека', {}],
  ['старый human', 'маршрут остановлен: human', 'нужно решение человека', {}],
  ['возвраты', 'BUILD: 2 возврата не помогли', 'повторные возвраты не помогли', {}],
  ['три попытки', 'BUILD: 3 попытки без результата', 'агент не вернул результат',
    { cause: /врем|прав|инструмент/i }],
  ['права', 'BUILD: агенту не дали записать результат', 'не хватило прав записать результат',
    { action: /прав|настройк/i }],
  ['sandbox_up', 'sandbox_up упал', 'стенд не запустился', { cause: /порт|песочниц/i }],
  ['среда 75', 'среда профиля не готова (код 75)', 'среда не готова',
    { what: /75/, action: /shared.*не удаляй|не удаля.*shared/i }],
  ['среда 73', 'среда профиля не готова (код 73)', 'среда не готова',
    { what: /73/, action: /владел/i }],
  ['архивная среда', 'v2: свежая v2-песочница не готова (код 73)', 'среда не готова',
    { what: /73/ }],
  ['timeout', 'BUILD: агент убит по таймауту', 'агент остановлен по времени',
    { action: /лимит|врем/i }],
  ['state-only', 'VERIFY: сторож state-only: узел verify изменил рабочее дерево — снимок экрана',
    'проверка изменила рабочие файлы', { what: /снимок экрана/, cause: /артефакт|правк/i }],
  ['fail-closed', 'dispatcher остановлен fail-closed (код 75)', 'движок остановился с ошибкой',
    { what: /75/ }],
  ['fallback', 'причина не записана', 'нужно выяснить причину остановки', {}],
];

/**
 * Вход повторяет событие журнала, которое читает detectStall, без реестра владельца.
 * Для всех правил одна и та же остановленная попытка исключает влияние окна журнала.
 */
function stopped(event, registry = {}) {
  return detectStall({
    registry: { STALLED_HUMAN: '1', ...registry },
    timeline: [{ ts: '2026-10-01 12:00:00', event }],
    daemonAlive: false,
  });
}

/**
 * Проверяется публичная структура полок, а не способ её сборки внутри правила.
 * Пустые дополнительные полки не должны создавать заголовки в интерфейсе.
 */
function assertPresentation(stall, reason, shelves = {}) {
  assert.ok(stall, 'вход обязан распознаваться как остановка');
  assert.ok(stall.presentation, 'у остановки нет краткого представления');

  const { presentation } = stall;

  assert.equal(presentation.reason, reason);
  assert.equal(typeof presentation.summary, 'string');
  assert.ok(presentation.summary.trim());
  assert.ok(presentation.details?.what?.trim());
  assert.ok(presentation.details?.action?.trim());

  for (const [key, value] of Object.entries(presentation.details)) {
    assert.ok(['what', 'cause', 'retained', 'action'].includes(key));
    assert.equal(typeof value, 'string');
    assert.ok(value.trim(), `пустая полка ${key}`);
  }

  for (const [key, pattern] of Object.entries(shelves)) {
    assert.match(presentation.details[key] || '', pattern, `полка ${key}`);
  }
}

for (const [name, event, reason, shelves] of cases) {
  test(`все виды дают краткую причину и непустые полки: ${name}`, () => {
    assertPresentation(stopped(event), reason, shelves);
  });

  test(`нет служебных шаблонов в собственных текстах: ${name}`, () => {
    const stall = stopped(event);
    const ownText = [stall.title, stall.hint, JSON.stringify(stall.presentation)].join('\n');

    assert.doesNotMatch(ownText, /t<TASK>|tNNNN|\bunknown\b/);
  });
}

test('обычный human не выдумывает причину сохранённую работу и счётчики', () => {
  const stall = stopped('BUILD: маршрут остановлен: human');

  assertPresentation(stall, 'нужно решение человека');
  assert.equal(stall.presentation.details.cause, undefined);
  assert.equal(stall.presentation.details.retained, undefined);
  assert.equal(stall.presentation.attempts, undefined);
  assert.equal(stall.presentation.returns, undefined);
});

test('старый COMMENT и unknown отображаются человечески без изменения исходных данных', () => {
  const comment = 'исчерпан бюджет повторов: 3 захода без результата, последний — unknown';
  const stall = stopped('SHIP: маршрут остановлен: human', { SHIP_COMMENT: comment, SHIP_FAILS: '0' });

  assertPresentation(stall, 'агент не вернул результат');
  assert.equal(stall.presentation.attempts, 3);
  assert.equal(stall.presentation.lastFailure, 'причина не названа');
  assert.equal(stall.fails, 0);
  assert.equal(stall.comment, comment);
  assert.equal(stall.detail, 'SHIP: маршрут остановлен: human');
  assert.doesNotMatch(stall.title, /unknown/);
});

test('числа берутся из события и не появляются при голом исчерпании', () => {
  const counted = stopped('BUILD: 2 возврата не помогли');
  const bare = stopped('BUILD: маршрут остановлен: human — исчерпан бюджет повторов');

  assertPresentation(counted, 'повторные возвраты не помогли');
  assert.equal(counted.presentation.returns, 2);
  assertPresentation(bare, 'агент не вернул результат');
  assert.equal(bare.presentation.attempts, undefined);
});

test('timeout не заявляет потерю или сохранность неизвестной работы', () => {
  const stall = stopped('BUILD: агент убит по таймауту');

  assertPresentation(stall, 'агент остановлен по времени');
  assert.equal(stall.presentation.details.retained, undefined);
  assert.doesNotMatch(stall.hint, /потеряна целиком/);
});

test('crashed сохраняет конкретику найденной остановки в полке', () => {
  for (const event of ['связь прервалась', 'BUILD: агенту не дали записать результат']) {
    const stall = detectStall({
      timeline: [{ ts: '2026-10-01 12:00:00', event }],
      daemonAlive: false,
    });

    assertPresentation(stall, 'прогон оборвался', { cause: /демон|процесс|маршрут/i });

    if (event.startsWith('BUILD:')) {
      assert.match(stall.presentation.details.what, /прав|результат/i);
    }
  }
});

const bootstrap = {
  phase: 'bootstrap',
  node: 'scout',
  visitId: 'b_test',
  recordHash: 'a'.repeat(64),
  outcome: 'failed',
  reason: 'Уточните рабочую папку <b>проекта</b>',
  at: '2026-10-01 12:00:00',
  verdict: null,
  runs: [],
  state: 'waiting',
  decision: null,
};

for (const state of ['waiting', 'answered']) {
  test(`bootstrap даёт только существующие полки: ${state}`, () => {
    const stop = {
      ...bootstrap,
      state,
      decision: state === 'answered' ? { recordHash: 'b'.repeat(64), answer: 'Ответ записан' } : null,
    };
    const stall = bootstrapStall(stop);

    assertPresentation(stall, state === 'answered' ? 'ответ сохранён' : 'нужен ответ человека');
    assert.match(stall.presentation.details.what, /<b>проекта<\/b>/);
    assert.equal(stall.presentation.details.cause, undefined);
    assert.equal(Boolean(stall.presentation.details.retained), state === 'answered');
  });
}

test('bootstrap показывает ошибку среды только когда она пришла из trusted stop', () => {
  const stall = bootstrapStall(bootstrap, 'Каталог проекта недоступен');

  assertPresentation(stall, 'нужен ответ человека', { cause: /Каталог проекта недоступен/ });
});

test('известные классы последнего сбоя отображаются человеческими подписями', () => {
  for (const [failure, label] of [
    ['timeout', 'убит по лимиту времени этапа'],
    ['missing_status', 'не выставил статус'],
    ['crashed', 'процесс упал'],
  ]) {
    const event = 'SHIP: маршрут остановлен: human — исчерпан бюджет повторов: '
      + `3 захода без результата, последний — ${failure}`;
    const stall = stopped(event);

    assertPresentation(stall, 'агент не вернул результат');
    assert.equal(stall.presentation.lastFailure, label);
    assert.doesNotMatch(stall.title, new RegExp(`\\b${failure}\\b`));
  }
});
