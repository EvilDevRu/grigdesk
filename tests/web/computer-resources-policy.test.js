import assert from 'node:assert/strict';
import test from 'node:test';

const policy = () => import('../../web/src/shared/layout/resourceMetrics.ts');

test('RP-01: свободные гигабайты и пределы датчика', async () => {
  const { diskClass, temperatureClass, loadClass, memoryView } = await policy();

  for (const [free, expected] of [[9.99, 'lv-bad'], [10, 'lv-warn'],
    [29.99, 'lv-warn'], [30, 'lv-ok']]) {
    assert.equal(diskClass(free), expected, `свободно ${free} ГБ, до округления`);
  }

  for (const [kind, warn, bad] of [['cpu', 80, 90], ['gpu', 80, 90], ['nvme', 60, 70]]) {
    assert.equal(temperatureClass({ celsius: warn - 0.01 }, kind), 'lv-ok');
    assert.equal(temperatureClass({ celsius: warn }, kind), 'lv-warn');
    assert.equal(temperatureClass({ celsius: bad - 0.01 }, kind), 'lv-warn');
    assert.equal(temperatureClass({ celsius: bad }, kind), 'lv-bad');
    assert.equal(temperatureClass({ celsius: 0 }, kind), 'lv-ok');
    assert.equal(temperatureClass({
      celsius: 55,
      maxCelsius: 55,
      critCelsius: 65,
    }, kind), 'lv-warn');
    assert.equal(temperatureClass({
      celsius: 65,
      maxCelsius: 55,
      critCelsius: 65,
    }, kind), 'lv-bad');
  }

  assert.equal(temperatureClass({ celsius: 94, maxCelsius: 95 }, 'cpu'), 'lv-ok');
  assert.equal(temperatureClass({ celsius: 95, maxCelsius: 95 }, 'cpu'), 'lv-bad');
  assert.equal(temperatureClass({ celsius: 54, critCelsius: 55 }, 'cpu'), 'lv-ok');
  assert.equal(temperatureClass({ celsius: 55, critCelsius: 55 }, 'cpu'), 'lv-bad');
  assert.equal(temperatureClass({
    celsius: 65,
    maxCelsius: 65,
    critCelsius: 65,
  }, 'nvme'), 'lv-bad');
  assert.equal(temperatureClass({
    celsius: 70,
    maxCelsius: 85,
    critCelsius: 65,
  }, 'nvme'), 'lv-bad');
  assert.ok(!temperatureClass(undefined, 'cpu'));

  assert.equal(loadClass(59.99), 'lv-ok');
  assert.equal(loadClass(60), 'lv-warn');
  assert.equal(loadClass(85), 'lv-bad');
  assert.deepEqual(memoryView({
    totalGb: 24,
    usedGb: 16,
    swapTotalGb: 8,
    swapUsedGb: 4,
  }), {
    ramTotal: 16,
    ramUsed: 12,
    ramFree: 4,
    ramPercent: 75,
    swapTotal: 8,
    swapUsed: 4,
    swapPercent: 50,
  });
});

test('RP-02: тревога только диска или температуры', async () => {
  const { resourcesAlarm } = await policy();
  const calm = {
    cpu: { percent: 99 },
    mem: { percent: 99 },
    gpus: [{ percent: 99 }],
  };

  assert.equal(resourcesAlarm(calm), false);
  assert.equal(resourcesAlarm({ cpu: { percent: 1 } }), false);
  assert.equal(resourcesAlarm({ ...calm, disks: [{ freeGb: 10 }] }), false);
  assert.equal(resourcesAlarm({ ...calm, disks: [{ freeGb: 9.99 }] }), true);

  for (const [kind, warn, bad] of [['cpu', 80, 90], ['gpu', 80, 90], ['nvme', 60, 70]]) {
    /**
     * Одно показание помещается в своего владельца для проверки общей тревоги.
     * Остальные высокие нагрузки остаются холодными и не влияют на результат.
     */
    const withTemperature = (celsius) => {
      const temperature = { celsius };

      return kind === 'cpu' ? { cpu: { percent: 1, temperature } }
        : kind === 'gpu' ? { ...calm, gpus: [{ temperature }] }
          : { ...calm, disks: [{ freeGb: 100, temperature }] };
    };

    assert.equal(resourcesAlarm(withTemperature(warn)), false);
    assert.equal(resourcesAlarm(withTemperature(bad)), true);
  }

  assert.equal(resourcesAlarm({
    ...calm,
    disks: [{ freeGb: 100, temperature: {
      celsius: 66,
      maxCelsius: 55,
      critCelsius: 65,
    } }],
  }), true);
});
