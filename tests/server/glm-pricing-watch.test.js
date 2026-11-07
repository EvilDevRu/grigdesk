// Сторож сверяет два приложенных Markdown-снимка, хранит факты и повторяет только
// отказавший источник. Все запросы подменены, снимки пишутся во временные каталоги.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const MODULE = '../../server/src/lib/glm/pricingWatch.ts';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 21, 6);
const URLS = {
  overview: 'https://docs.z.ai/devpack/overview.md',
  revision: 'https://docs.z.ai/devpack/notice/usage-revision.md',
};
const PAGES = {
  overview: await fs.readFile(
    new URL('../fixtures/zai-devpack-overview-2026-10-21.md', import.meta.url),
    'utf8',
  ),
  revision: await fs.readFile(
    new URL('../fixtures/zai-devpack-usage-revision-2026-10-21.md', import.meta.url),
    'utf8',
  ),
};

async function runtimeHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-pricing-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return path.join(root, 'runtime');
}

function markdownResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/markdown' } });
}

/**
 * Фейк принимает только два публичных адреса; любой посторонний запрос проваливает тест.
 * Сценарий меняет один источник, не влияя на ответ второго и журнал запросов.
 */
function publicPages(overrides = {}) {
  const calls = [];
  /**
   * Записывает запрос перед ответом, чтобы отказ также остался в журнале.
   * Неизвестный адрес считается ошибкой теста, а не сетевой недоступностью.
   */
  const fetchImpl = async (url, init = {}) => {
    const source = Object.keys(URLS).find((key) => URLS[key] === String(url));

    assert.ok(source, `неожиданный URL: ${url}`);
    calls.push({
      source,
      url: String(url),
      init,
    });

    const result = overrides[source];

    if (typeof result === 'function') {
      return result(init);
    }

    return markdownResponse(result ?? PAGES[source]);
  };

  return { calls, fetchImpl };
}

/**
 * Меняет ровно одно вхождение факта, включая повторённое окно или пару коэффициентов.
 * Отсутствующая подстрока — ошибка фикстуры, которую видно до вызова будущего парсера.
 */
function replaceOccurrence(text, needle, replacement, occurrence = 0) {
  let at = -1;

  for (let index = 0; index <= occurrence; index += 1) {
    at = text.indexOf(needle, at + 1);
    assert.notEqual(at, -1, `в снимке нет вхождения ${occurrence}: ${needle}`);
  }

  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

/**
 * Мутанты изменяют наблюдаемые числа, а не только отношение пика к дешёвому времени.
 * У revision независимо проверяется каждое повторённое окно и каждая модель в обоих разделах.
 */
function mutations() {
  const cases = [];

  for (const [source, count] of [['overview', 1], ['revision', 2]]) {
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      for (const [field, needle, replacement, observed] of [
        ['начало', '14:00–18:00', '15:00–18:00', /15:00|900/u],
        ['конец', '14:00–18:00', '14:00–19:00', /19:00|1140/u],
        ['дни', 'Monday to Friday', 'Monday to Thursday', /Thursday|четверг|\b4\b/u],
        ['зона', '18:00 Singapore Standard Time (UTC+8)',
          '18:00 Singapore Standard Time (UTC+9)', /UTC\+9|540/u],
      ]) {
        cases.push({
          source,
          field,
          needle,
          replacement,
          observed,
          occurrence,
        });
      }
    }
  }

  cases.push({
    source: 'revision',
    field: 'выходные',
    needle: 'weekends will be deducted at off-peak rates all day',
    replacement: 'weekends will be deducted at peak rates all day',
    observed: /(?:выходн|weekend).*?(?:false|пик|peak)/iu,
    occurrence: 0,
  });

  for (const [field, needle, replacement, observed] of [
    ['credits offPeak', '0.5× the standard credit rate', '0.6× the standard credit rate', /0[,.]6/u],
    ['credits peak', '1× the standard credit rate', '1.1× the standard credit rate', /1[,.]1/u],
  ]) {
    cases.push({
      source: 'overview',
      field,
      needle,
      replacement,
      observed,
      occurrence: 0,
    });
  }

  for (let occurrence = 0; occurrence < 2; occurrence += 1) {
    for (const [field, needle, replacement, observed] of [
      ['GLM-5.3 offPeak', '1× during off-peak', '2× during off-peak', /2/u],
      ['GLM-5.3 peak', '3× during peak', '4× during peak', /4/u],
      ['GLM-5.3-Flash offPeak', '0.4× during off-peak', '0.5× during off-peak', /0[,.]5/u],
      ['GLM-5.3-Flash peak', '1.2× during peak', '1.5× during peak', /1[,.]5/u],
    ]) {
      cases.push({
        source: 'revision',
        field,
        needle,
        replacement,
        observed,
        occurrence,
      });
    }
  }

  return cases;
}

test('оба снимка Z.ai сверяются с константами', async (t) => {
  for (const source of Object.keys(PAGES)) {
    await t.test(source, async () => {
      const { parseGlmPricingPage, compareGlmPricingPage } = await import(MODULE);
      const page = parseGlmPricingPage(source, PAGES[source]);

      assert.equal(compareGlmPricingPage(source, page).kind, 'verified');

      const equivalent = PAGES[source]
        .replaceAll('14:00–18:00', '14:00 - 18:00')
        .replaceAll('Monday to Friday', '**Monday** to   Friday');

      assert.equal(compareGlmPricingPage(source, parseGlmPricingPage(source, equivalent)).kind, 'verified');
    });
  }
});

test('изменённые часы, дни и каждый коэффициент названы', async (t) => {
  for (const mutation of mutations()) {
    const { source, field, needle, replacement, observed, occurrence } = mutation;
    const changed = replaceOccurrence(PAGES[source], needle, replacement, occurrence);

    await t.test(`${source}: ${field}, вхождение ${occurrence + 1}`, async () => {
      const { parseGlmPricingPage, compareGlmPricingPage } = await import(MODULE);
      const verdict = compareGlmPricingPage(source, parseGlmPricingPage(source, changed));
      const details = verdict.details?.join('; ') ?? '';

      assert.equal(verdict.kind, 'mismatch');
      assert.ok(verdict.details.length > 0);
      assert.ok(details.includes(source), 'назван источник');
      assert.match(details, observed, 'названо наблюдаемое значение');

      if (field.startsWith('GLM-')) {
        assert.ok(details.includes(field.split(' ')[0]), 'названа модель коэффициента');
      } else if (field.startsWith('credits')) {
        assert.match(details, /credit|кредит/iu, 'названа кредитная пара');
      } else {
        assert.match(details, /пик|час|окон|расписан|дн|зон|UTC|выходн|weekend/iu, 'названо поле');
      }
    });
  }

  const scaled = [
    ['overview', PAGES.overview.replace('0.5× the standard', '1× the standard')
      .replace('1× the standard credit rate.\n\n**By', '2× the standard credit rate.\n\n**By'), /1.*2/u],
    ['revision', PAGES.revision.replaceAll('1× during off-peak', '2× during off-peak')
      .replaceAll('3× during peak', '6× during peak'), /2.*6/u],
    ['revision', PAGES.revision.replaceAll('0.4× during off-peak', '0.8× during off-peak')
      .replaceAll('1.2× during peak', '2.4× during peak'), /0[,.]8.*2[,.]4/u],
  ];

  for (const [source, changed, observed] of scaled) {
    await t.test(`${source}: масштабирование пары ${observed}`, async () => {
      const { parseGlmPricingPage, compareGlmPricingPage } = await import(MODULE);
      const verdict = compareGlmPricingPage(source, parseGlmPricingPage(source, changed));

      assert.equal(verdict.kind, 'mismatch', 'сохранённое отношение не скрывает смену расходов');
      assert.match(verdict.details.join('; '), observed);
    });
  }
});

test('страница без тарифных фраз не разобрана', async (t) => {
  for (const source of Object.keys(PAGES)) {
    await t.test(source, async () => {
      const { parseGlmPricingPage, compareGlmPricingPage } = await import(MODULE);
      const page = parseGlmPricingPage(source, '# Documentation\nSee the console.');

      assert.equal(compareGlmPricingPage(source, page).kind, 'unparsed');

      // Прочитанное отличие важнее пропажи остальных обязательных тарифных фактов.
      const partial = 'Peak hours: Monday to Friday, 14:00–19:00 Singapore Standard Time (UTC+8).';
      const verdict = compareGlmPricingPage(source, parseGlmPricingPage(source, partial));

      assert.equal(verdict.kind, 'mismatch');
      assert.match(verdict.details.join('; '), /19:00|1140/u);
    });
  }
});

test('публичные GET без ключа и cookie', async (t) => {
  const { watchGlmPricing, glmPricingStatus } = await import(MODULE);
  const home = await runtimeHome(t);
  const fake = publicPages();
  const snapshot = await watchGlmPricing({
    runtimeHome: home,
    now: NOW,
    fetchImpl: fake.fetchImpl,
  });

  assert.equal(glmPricingStatus(snapshot).kind, 'verified');
  assert.deepEqual(fake.calls.map((call) => call.url).sort(), Object.values(URLS).sort());

  for (const { init } of fake.calls) {
    const headers = new Headers(init.headers);

    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(headers.get('accept'), 'text/markdown');
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('cookie'), null);
    assert.ok(init.body == null);
    assert.ok(init.signal instanceof AbortSignal, 'у каждого запроса есть таймаут');
  }

  for (const [label, response, expectedFailure] of [
    ['HTTP', async () => markdownResponse('synthetic-secret', 503), /^HTTP 503$/u],
    ['сеть', async () => {
      throw Object.assign(new TypeError('secret https://private.test'), { cause: { code: 'ENOTFOUND' } });
    }, /^ENOTFOUND$/u],
    ['обрыв', async (_url, init) => {
      try {
        await delay(100, undefined, { signal: init.signal });
      } catch {
        // fetch отклоняется причиной сигнала, а таймер оборачивает её в cause.
        throw init.signal.reason;
      }

      return markdownResponse('не должно успеть');
    }, /AbortError|TimeoutError/u],
  ]) {
    await t.test(label, async (subtest) => {
      const failedHome = await runtimeHome(subtest);
      const failed = await watchGlmPricing({
        runtimeHome: failedHome,
        now: NOW,
        timeoutMs: 5,
        fetchImpl: response,
      });

      assert.equal(glmPricingStatus(failed).kind, 'unreachable');

      for (const source of Object.keys(URLS)) {
        assert.match(failed.sources[source].failure, expectedFailure);
        assert.equal(JSON.stringify(failed.sources[source]).includes('secret'), false);
      }
    });
  }
});

test('суточная сверка переживает рестарт', async (t) => {
  const { watchGlmPricing, readGlmPricingSnapshot, glmPricingSnapshotPath } = await import(MODULE);
  const home = await runtimeHome(t);
  const fake = publicPages();
  const first = await watchGlmPricing({
    runtimeHome: home,
    now: NOW,
    fetchImpl: fake.fetchImpl,
  });

  assert.equal(fake.calls.length, 2);
  assert.equal(path.basename(glmPricingSnapshotPath(home)), 'glm-pricing-check.json');
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(glmPricingSnapshotPath(home))).mode & 0o777, 0o600);
  assert.deepEqual(await readGlmPricingSnapshot(home), first);

  for (const source of Object.keys(URLS)) {
    assert.equal(first.sources[source].checkedAt, NOW);
    assert.equal(first.sources[source].fetchedAt, NOW);
    assert.equal(first.sources[source].failure, null);
    assert.ok(first.sources[source].page);
  }

  // Новое выполнение модуля читает тот же файл, как при рестарте процесса сервера.
  const restarted = await import(`${MODULE}?restart=glm-pricing-test`);

  for (const later of [NOW + 5 * 60_000, NOW + 23 * HOUR]) {
    const cached = await restarted.watchGlmPricing({
      runtimeHome: home,
      now: later,
      fetchImpl: fake.fetchImpl,
    });

    assert.equal(fake.calls.length, 2);
    assert.deepEqual(cached, first);
  }

  await restarted.watchGlmPricing({
    runtimeHome: home,
    now: NOW + DAY,
    fetchImpl: fake.fetchImpl,
  });

  assert.equal(fake.calls.length, 4, 'ровно через сутки обновляются оба источника');

  const unparsedHome = await runtimeHome(t);
  const unparsed = publicPages({ overview: '# Other page', revision: '# Other page' });

  await watchGlmPricing({
    runtimeHome: unparsedHome,
    now: NOW,
    fetchImpl: unparsed.fetchImpl,
  });
  await watchGlmPricing({
    runtimeHome: unparsedHome,
    now: NOW + HOUR,
    fetchImpl: unparsed.fetchImpl,
  });

  assert.equal(unparsed.calls.length, 2, 'HTTP 200 без тарифных фраз ждёт сутки, а не час');

  await watchGlmPricing({
    runtimeHome: unparsedHome,
    now: NOW + DAY,
    fetchImpl: unparsed.fetchImpl,
  });

  assert.equal(unparsed.calls.length, 4);
});

test('повтор отказавшего источника через час сохраняет факты', async (t) => {
  const { watchGlmPricing } = await import(MODULE);
  const home = await runtimeHome(t);
  const initial = publicPages();
  const first = await watchGlmPricing({
    runtimeHome: home,
    now: NOW,
    fetchImpl: initial.fetchImpl,
  });
  const failing = publicPages({
    revision: async () => {
      throw Object.assign(new TypeError('secret'), { cause: { code: 'ETIMEDOUT' } });
    },
  });
  const failed = await watchGlmPricing({
    runtimeHome: home,
    now: NOW + DAY,
    fetchImpl: failing.fetchImpl,
  });

  assert.equal(failed.sources.overview.fetchedAt, NOW + DAY);
  assert.equal(failed.sources.revision.checkedAt, NOW + DAY);
  assert.equal(failed.sources.revision.fetchedAt, NOW);
  assert.deepEqual(failed.sources.revision.page, first.sources.revision.page);
  assert.equal(failed.sources.revision.failure, 'ETIMEDOUT');

  const recovered = publicPages();

  await watchGlmPricing({
    runtimeHome: home,
    now: NOW + DAY + 59 * 60_000,
    fetchImpl: recovered.fetchImpl,
  });

  assert.equal(recovered.calls.length, 0);

  const retried = await watchGlmPricing({
    runtimeHome: home,
    now: NOW + DAY + HOUR,
    fetchImpl: recovered.fetchImpl,
  });

  assert.deepEqual(recovered.calls.map((call) => call.source), ['revision']);
  assert.equal(retried.sources.revision.failure, null);
  assert.equal(retried.sources.revision.fetchedAt, NOW + DAY + HOUR);

  await watchGlmPricing({
    runtimeHome: home,
    now: NOW + 2 * DAY,
    fetchImpl: recovered.fetchImpl,
  });

  assert.deepEqual(recovered.calls.map((call) => call.source), ['revision', 'overview']);
});

test('mismatch не скрывается частичным отказом', async (t) => {
  const { watchGlmPricing, glmPricingStatus } = await import(MODULE);

  for (const source of Object.keys(URLS)) {
    await t.test(`расхождение ${source}`, async (subtest) => {
      const home = await runtimeHome(subtest);
      const other = source === 'overview' ? 'revision' : 'overview';
      const changed = PAGES[source].replaceAll('14:00–18:00', '14:00–19:00');
      const mixed = publicPages({
        [source]: changed,
        [other]: async () => markdownResponse('busy', 503),
      });
      const first = await watchGlmPricing({
        runtimeHome: home,
        now: NOW,
        fetchImpl: mixed.fetchImpl,
      });
      const status = glmPricingStatus(first);

      assert.equal(status.kind, 'mismatch');
      assert.match(status.details.join('; '), /19:00|1140/u);
      assert.ok(status.details.join('; ').includes(source));

      const offline = publicPages({
        overview: async () => markdownResponse('busy', 503),
        revision: async () => markdownResponse('busy', 503),
      });
      const old = await watchGlmPricing({
        runtimeHome: home,
        now: NOW + DAY,
        fetchImpl: offline.fetchImpl,
      });

      assert.equal(glmPricingStatus(old).kind, 'mismatch');
      assert.equal(old.sources[source].fetchedAt, NOW);
      assert.deepEqual(old.sources[source].page, first.sources[source].page);
    });
  }
});

test('битый снимок безопасен, verdict не хранится', async (t) => {
  const { watchGlmPricing, readGlmPricingSnapshot, glmPricingSnapshotPath, glmPricingStatus } =
    await import(MODULE);
  const home = await runtimeHome(t);

  assert.equal(await readGlmPricingSnapshot(home), null);

  const fake = publicPages();
  const first = await watchGlmPricing({
    runtimeHome: home,
    now: NOW,
    fetchImpl: fake.fetchImpl,
  });
  const file = glmPricingSnapshotPath(home);
  const invalid = [
    '{',
    JSON.stringify({ sources: { overview: { checkedAt: 'вчера', page: 42 } } }),
    JSON.stringify({
      sources: {
        overview: { ...first.sources.overview, checkedAt: NOW + DAY },
        revision: { ...first.sources.revision, checkedAt: NOW + DAY },
      },
    }),
  ];

  for (const contents of invalid) {
    await fs.writeFile(file, contents);

    const next = publicPages();
    const rebuilt = await watchGlmPricing({
      runtimeHome: home,
      now: NOW,
      fetchImpl: next.fetchImpl,
    });

    assert.equal(next.calls.length, 2, 'битый или будущий снимок не кеширует попытку');
    assert.equal(glmPricingStatus(rebuilt).kind, 'verified');
  }

  const stored = JSON.parse(await fs.readFile(file, 'utf8'));

  assert.equal(Object.hasOwn(stored, 'kind'), false);
  assert.equal(Object.hasOwn(stored, 'verdict'), false);
  assert.equal(Object.hasOwn(stored, 'observation'), false);

  for (const source of Object.keys(URLS)) {
    assert.equal(Object.hasOwn(stored.sources[source], 'kind'), false);
    assert.equal(Object.hasOwn(stored.sources[source], 'verdict'), false);
    assert.equal(Object.hasOwn(stored.sources[source], 'observation'), false);
  }

  // После правки сохранённых фактов статус меняется без HTTP: вывод не закеширован на диске.
  const { parseGlmPricingPage } = await import(MODULE);

  stored.sources.overview.page = parseGlmPricingPage('overview', PAGES.overview.replace('18:00', '19:00'));
  await fs.writeFile(file, JSON.stringify(stored));

  assert.equal(glmPricingStatus(await readGlmPricingSnapshot(home)).kind, 'mismatch');
});
