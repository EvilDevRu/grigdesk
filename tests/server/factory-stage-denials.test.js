import assert from 'node:assert/strict';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';

// Отказ политики прав внутри хода. Движок пишет их числом в `DENIALS_<STAGE>`, GrigDesk
// показывает чипом в модалке узла. Смысл величины — предупредить о ПОДМЕНЕ проверки:
// агент, которому запретили нужный запуск, склонен подобрать похожий и выдать его
// результат за доказательство. Одного правила в промпте для этого мало — оно уже стояло
// и было нарушено на живом прогоне.

const adapter = () => new FactoryStateAdapter({ stateDir: '/nonexistent', profilesDir: '/nonexistent' });

test('число отказов политики доезжает до карточки этапа', () => {
  const { map } = adapter().buildStageMap({ ROUTE: 'trivial', BUILD: 'done', DENIALS_BUILD: '3' });
  assert.equal(map.BUILD.denials, 3);
});

test('ноль отказов остаётся нулём, а не пропадает как пустое значение', () => {
  // `'0'` — правдивый факт: ход дошёл до результата и запретов в нём не было. Проверка
  // на truthy превратила бы его в «не знаем», а строка в JS при этом ещё и truthy —
  // отсюда строгая проверка формата, а не сокращённая запись.
  const { map } = adapter().buildStageMap({ ROUTE: 'trivial', BUILD: 'done', DENIALS_BUILD: '0' });
  assert.equal(map.BUILD.denials, 0);
});

test('отсутствие ключа означает «не знаем», а не ноль', () => {
  // Оборванный ход (таймаут, KILL, падение) не доходит до события результата, и отказы
  // в нём могли быть. Движок в этом случае ключ не пишет вовсе.
  const { map } = adapter().buildStageMap({ ROUTE: 'trivial', BUILD: 'done' });
  assert.equal(map.BUILD.denials, null);
});

test('мусор в реестре не превращается в число', () => {
  // Реестр — provider-writable проекция, поэтому значение проверяется, а не приводится:
  // `Number('нет')` дал бы NaN, и чип показал бы «NaN отказ. прав».
  for (const value of ['нет', '-1', '2.5', '', ' 3', '1e3']) {
    const { map } = adapter().buildStageMap({ ROUTE: 'trivial', BUILD: 'done', DENIALS_BUILD: value });
    assert.equal(map.BUILD.denials, null, `значение ${JSON.stringify(value)} не должно стать числом`);
  }
});
