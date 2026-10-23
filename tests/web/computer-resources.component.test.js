import assert from 'node:assert/strict';
import test from 'node:test';

import { formatNumber } from '../../shared/i18n/formats.ts';
import {
  extendedMetrics,
  labels,
  oldMetrics,
  resourceRow,
  resourcesBrowser,
} from './helpers/computer-resources-browser.js';

const TEST_OPTIONS = { timeout: 120000 };

/**
 * Проверяет проценты, полосу и показание конкретного устройства одной строкой.
 * Ожидаемые числа приходят из того же синтетического DTO, что читает компонент.
 */
function assertDeviceRow(row, device, locale) {
  assert.ok(row.text.includes(device.name || device.mountpoint));
  assert.ok(row.text.includes(formatNumber(device.temperature.celsius, locale,
    { maximumFractionDigits: 1 })));
  assert.ok(Math.abs(row.width - device.percent) < 0.001);

  if (device.name) {
    assert.ok(row.head.includes(`${formatNumber(device.percent, locale)}%`));
    assert.ok(row.note.includes(formatNumber(device.memoryUsedGb, locale,
      { maximumFractionDigits: 1 })));
    assert.ok(row.note.includes(formatNumber(device.memoryTotalGb, locale,
      { maximumFractionDigits: 1 })));
    assert.match(row.note, /видеопамять|video memory|VRAM/i);
  } else {
    assert.ok(row.head.includes(formatNumber(device.freeGb, locale, { maximumFractionDigits: 1 })));
    assert.match(row.head, /свободно|free/i);
    assert.ok(row.note.includes(formatNumber(device.usedGb, locale, { maximumFractionDigits: 1 })));
    assert.ok(row.note.includes(formatNumber(device.totalGb, locale, { maximumFractionDigits: 1 })));
    assert.match(row.note, /занято|used/i);
  }
}

test('UI-01: GPU и разделы своего устройства', TEST_OPTIONS, async (t) => {
  const metrics = extendedMetrics();
  const h = await resourcesBrowser(t, metrics);

  await h.open();
  assert.equal(await h.panel.locator('.pu-row').count(), 7,
    'на базе только CPU/RAM/swap; двух GPU и двух разделов пока нет');

  const cpu = await resourceRow(h.panel, labels.ru.cpu);

  assert.ok(cpu.head.includes('72,8'));

  for (const device of [...metrics.gpus, ...metrics.disks]) {
    assertDeviceRow(await resourceRow(h.panel, device.name || device.mountpoint), device, 'ru');
  }

  const first = await resourceRow(h.panel, metrics.disks[0].mountpoint);
  const second = await resourceRow(h.panel, metrics.disks[1].mountpoint);

  assert.match(first.text, /диск данных GrigDesk/i);
  assert.doesNotMatch(second.text, /диск данных GrigDesk/i);
  assert.match(first.classes, /lv-warn/);
  assert.match(second.classes, /lv-ok/);
  assert.doesNotMatch(first.text, /53\s*°|61\s*°|35\s*°/);
  assert.doesNotMatch(cpu.text, /53\s*°|41\s*°/);
  assert.doesNotMatch(await h.panel.innerText(), /acpitz|gigabyte_wmi|iwlwifi/);
});

test('UI-02: RU/EN и неполные устройства', TEST_OPTIONS, async (t) => {
  const metrics = extendedMetrics();

  metrics.gpus.push({
    id: 'unknown',
    name: 'Без перевода / GPU N/A',
    temperature: { celsius: 0 },
  });

  const h = await resourcesBrowser(t, metrics);

  await h.open();

  const unknown = await resourceRow(h.panel, 'Без перевода / GPU N/A');

  assert.match(unknown.head, /—/);
  assert.equal(unknown.width, 0);
  assert.doesNotMatch(unknown.text, /NaN|undefined|0\s*(из|of)\s*0/);
  assert.ok(unknown.head.includes('0'));
  assertDeviceRow(await resourceRow(h.panel, metrics.gpus[0].name), metrics.gpus[0], 'ru');
  await h.language('en');
  assert.equal(await h.panel.isVisible(), true, 'открытая плитка меняет язык без пересоздания');

  const english = await resourceRow(h.panel, metrics.gpus[0].name);

  assertDeviceRow(english, metrics.gpus[0], 'en');
  assert.match(english.note, /1\.5/);

  const disk = await resourceRow(h.panel, metrics.disks[1].mountpoint);

  assertDeviceRow(disk, metrics.disks[1], 'en');
  assert.match(disk.head, /54\.5/);
  assert.match((await resourceRow(h.panel, metrics.disks[0].mountpoint)).text,
    /GrigDesk.*data|data.*GrigDesk/i);
  assert.ok((await resourceRow(h.panel, 'Без перевода / GPU N/A')).text.includes('Без перевода / GPU N/A'));
  await h.language('ru');
  assert.match((await resourceRow(h.panel, metrics.gpus[0].name)).note, /1,5/);
});

test('UI-04: старый сервер и отсутствие датчиков', TEST_OPTIONS, async (t) => {
  const metrics = extendedMetrics();
  const h = await resourcesBrowser(t, metrics);

  await h.open();
  assert.equal(await h.panel.locator('.pu-row').count(), 7, 'новые строки должны существовать до удаления');
  await h.setMetrics(oldMetrics());
  assert.equal(await h.panel.locator('.pu-row').count(), 3);
  assert.doesNotMatch(await h.panel.innerText(), /Fixture RTX|Fixture Radeon|\/data\/|°/);
  await h.setMetrics({
    ...oldMetrics(),
    gpus: [],
    disks: [],
  });
  assert.equal(await h.panel.locator('.pu-row').count(), 3);

  const noSensors = extendedMetrics();

  delete noSensors.cpu.temperature;

  for (const device of [...noSensors.gpus, ...noSensors.disks]) {
    delete device.temperature;
  }

  await h.setMetrics(noSensors);
  assert.equal(await h.panel.locator('.pu-row').count(), 7);
  assert.doesNotMatch(await h.panel.innerText(), /°|NaN|undefined/);
  await h.setMetrics(null, true);
  assert.ok((await h.panel.innerText()).includes(labels.ru.noFreshDataTheServerDidNot));
  assert.equal(await h.panel.locator('.pu-row').count(), 7);
});

/**
 * Метку определяет видимый красный элемент без привязки к имени нового CSS-класса.
 * Прежние CPU/RAM исключены: их красный цвет сам по себе тревогой не является.
 */
async function alarmVisible(trigger) {
  return trigger.evaluate((element) => [...element.querySelectorAll('*')].some((node) => {
    if (node.closest('b')) {
      return false;
    }

    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    const redColor = [style.color, style.backgroundColor, style.fill].some((color) => {
      const channels = color?.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);

      return channels && Number(channels[1]) > 150
        && Number(channels[1]) > Number(channels[2]) * 1.25
        && Number(channels[1]) > Number(channels[3]) * 1.1;
    });
    const red = /lv-bad|alarm|alert|danger/.test(node.className || '') || redColor;

    return red && box.width > 0 && box.height > 0
      && style.visibility !== 'hidden' && Number(style.opacity) > 0;
  }));
}

test('UI-03: красная тревога без новых цифр', TEST_OPTIONS, async (t) => {
  const metrics = oldMetrics();
  const h = await resourcesBrowser(t, metrics);

  assert.equal(await alarmVisible(h.trigger), false);

  for (const kind of ['disk', 'cpu', 'gpu', 'nvme']) {
    const snapshot = extendedMetrics();

    if (kind === 'disk') {
      snapshot.disks[0].freeGb = 9.99;
    } else if (kind === 'cpu') {
      snapshot.cpu.temperature.celsius = 90;
    } else if (kind === 'gpu') {
      snapshot.gpus[0].temperature.celsius = 90;
    } else {
      snapshot.disks[0].temperature.celsius = 85;
    }

    await h.setMetrics(snapshot);
    assert.equal(await alarmVisible(h.trigger), true, `красный ${kind} должен включить метку`);

    const triggerText = await h.trigger.innerText();

    assert.match(triggerText, /CPU\s+42%/);
    assert.match(triggerText, /RAM\s+16\s*\/\s*24/);
    assert.doesNotMatch(triggerText, /Fixture|9[,.]99|72[,.]8|°|\/data/);
  }

  await h.setMetrics({ cpu: { ...metrics.cpu, percent: 99 }, mem: { ...metrics.mem, percent: 99 } });
  assert.equal(await alarmVisible(h.trigger), false, 'высокая нагрузка CPU/RAM не создаёт метку');
  await h.setMetrics(extendedMetrics());
  assert.equal(await alarmVisible(h.trigger), false, 'жёлтый диск не создаёт метку');
});

test('BR-01: ширина метрики и доступность панели', TEST_OPTIONS, async (t) => {
  const h = await resourcesBrowser(t);

  for (const locale of ['ru', 'en']) {
    await h.language(locale);

    for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 500 }]) {
      await h.page.setViewportSize(viewport);
      await h.setMetrics(oldMetrics());

      const before = await h.trigger.boundingBox();
      const neighbors = await h.page.locator('.topbar-actions').boundingBox();
      const metrics = extendedMetrics();

      metrics.disks[0].freeGb = 5;

      for (let index = 0; index < 20; index += 1) {
        metrics.gpus.push({
          ...metrics.gpus[0],
          id: `long-${index}`,
          name: `GPU ${index} ${'ДлинноеИмяУстройства'.repeat(15)}`,
        });
        metrics.disks.push({
          ...metrics.disks[1],
          id: `disk-${index}`,
          mountpoint: `/long/${index}/${'long-path-segment/'.repeat(20)}`,
        });
      }

      await h.setMetrics(metrics);
      assert.equal(await alarmVisible(h.trigger), true, 'на базе метки пока нет');

      const after = await h.trigger.boundingBox();
      const neighborsAfter = await h.page.locator('.topbar-actions').boundingBox();

      assert.ok(Math.abs(after.width - before.width) <= 0.5, 'тревога не расширяет trigger');
      assert.ok(Math.abs(neighborsAfter.x - neighbors.x) <= 0.5, 'соседние controls не сдвигаются');
      await h.trigger.focus();
      await h.trigger.press('ArrowDown');
      await h.panel.waitFor();

      const geometry = await h.panel.evaluate((panel) => {
        const body = panel;
        const box = panel.getBoundingClientRect();

        return {
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          screenWidth: innerWidth,
          screenHeight: innerHeight,
          overflowsX: body.scrollWidth > body.clientWidth + 1,
          scrollable: body.scrollHeight > body.clientHeight,
          overflowY: getComputedStyle(body).overflowY,
        };
      });

      assert.ok(geometry.left >= 0 && geometry.right <= geometry.screenWidth);
      assert.ok(geometry.bottom <= geometry.screenHeight);
      assert.equal(geometry.overflowsX, false, 'длинные пути переносятся внутри плитки');
      assert.equal(geometry.scrollable, true);
      assert.match(geometry.overflowY, /auto|scroll/);
      await h.page.keyboard.press('Escape');
      await h.panel.waitFor({ state: 'hidden' });
      assert.equal(await h.trigger.evaluate((node) => document.activeElement === node), true);
      await h.open();
      await h.page.keyboard.press('Escape');
    }
  }

  await h.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await h.trigger.isVisible(), false);

  const touch = await resourcesBrowser(t, extendedMetrics(), {
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });

  assert.equal(await touch.trigger.isVisible(), false);
});
