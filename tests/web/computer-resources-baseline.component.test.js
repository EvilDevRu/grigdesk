import assert from 'node:assert/strict';
import test from 'node:test';

import { formatNumber } from '../../shared/i18n/formats.ts';
import { labels, oldMetrics, resourceRow, resourcesBrowser } from './helpers/computer-resources-browser.js';

test('PRES-02: исходная панель, старый mem и stale', { timeout: 120000 }, async (t) => {
  for (const locale of ['ru', 'en']) {
    const original = oldMetrics();
    const h = await resourcesBrowser(t, original, { locale: locale === 'ru' ? 'ru-RU' : 'en-US' });
    const text = labels[locale];

    assert.equal(await h.trigger.getAttribute('aria-label'), text.computerResources);
    assert.match(await h.trigger.innerText(), /CPU\s+42%/);
    assert.match(await h.trigger.innerText(), /RAM\s+16\s*\/\s*24/);
    await h.open();
    assert.equal(await h.panel.locator('.pu-row').count(), 3);

    const cpu = await resourceRow(h.panel, text.cpu);
    const ram = await resourceRow(h.panel, text.ram);
    const swap = await resourceRow(h.panel, text.swap);

    assert.equal(cpu.width, original.cpu.percent);
    assert.ok(cpu.note.includes(text.averageLoadOverOneMinute));
    assert.ok(cpu.note.includes(formatNumber(original.cpu.load1, locale)));
    assert.equal(ram.width, 75);
    assert.match(ram.head, /75%/);
    assert.match(ram.note, /12.*16.*4/);
    assert.equal(swap.width, 50);
    assert.match(swap.note, /4.*8/);
    assert.ok((await h.panel.innerText()).includes(text.theHeaderCombinesRAMAndSwapUsed));

    const fallback = {
      ...original,
      mem: {
        totalGb: 24,
        usedGb: 16,
        percent: 67,
        swapTotalGb: 8,
        swapUsedGb: 4,
      },
    };

    await h.setMetrics(fallback);
    assert.equal((await resourceRow(h.panel, text.ram)).width, 75);
    assert.equal((await resourceRow(h.panel, text.swap)).width, 50);

    const disabled = { ...original, mem: {
      totalGb: 16,
      usedGb: 12,
      percent: 75,
    } };

    await h.setMetrics(disabled);
    assert.equal(await h.panel.locator('.pu-row').count(), 2);
    assert.ok((await h.panel.innerText()).includes(text.swapDisabled));
    assert.equal((await resourceRow(h.panel, text.ram)).width, 75);

    const before = await h.page.evaluate(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
        ._s.get('system');

      return { data: JSON.parse(JSON.stringify(store.data)), time: store.updatedAt };
    });

    await h.setMetrics(null, true);
    assert.ok((await h.trigger.getAttribute('class')).includes('stale'));
    assert.ok((await h.panel.innerText()).includes(text.noFreshDataTheServerDidNot));

    const after = await h.page.evaluate(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
        ._s.get('system');

      return { data: JSON.parse(JSON.stringify(store.data)), time: store.updatedAt };
    });

    assert.deepEqual(after, before);
    await h.page.keyboard.press('Escape');
    await h.page.setViewportSize({ width: 390, height: 844 });
    await h.trigger.waitFor({ state: 'hidden' });
    assert.equal(await h.page.locator('[data-shell-status-trigger]').isVisible(), true);
  }
});
