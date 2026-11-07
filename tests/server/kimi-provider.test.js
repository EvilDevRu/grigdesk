import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import kimi from '../../server/src/lib/executors/kimi.ts';
import { getExecutor, getProviderAdapters } from '../../server/src/lib/executors/index.ts';
import {
  classifyKimiUsageResponse,
  parseReadyUrl,
  parseKimiUsageBars,
  parseKimiUsageResources,
  requestKimiManagedUsage,
} from '../../server/src/lib/kimi/usage.ts';

test('Kimi setup-карточка проверяет системный CLI и login без чтения credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'kimi');
  const kimiHome = path.join(root, '.kimi-code');
  await fs.writeFile(bin, '#!/bin/sh\nprintf "0.31.1\\n"\n', { mode: 0o755 });

  const config = { kimiBin: bin, kimiHome };
  assert.deepEqual(await kimi.probe(config), { ok: true, version: '0.31.1' });
  assert.deepEqual(await kimi.auth(config), {
    mode: 'none',
    label: 'не авторизован (kimi login)',
    available: false,
  });

  await fs.mkdir(path.join(kimiHome, 'credentials'), { recursive: true });
  await fs.writeFile(path.join(kimiHome, 'credentials', 'kimi-code.json'), 'не читать');
  assert.deepEqual(await kimi.auth(config), {
    mode: 'cli',
    label: 'CLI хоста (kimi login)',
    available: true,
  });
  assert.equal(typeof kimi.run, 'function');
  assert.equal(kimi.securityProfile, 'kimi-contained-v1');
  assert.equal(kimi.seedModels().length, 4);
  assert.equal(kimi.install, 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash');
  assert.equal(kimi.login, 'kimi login');
});

test('Kimi setup-карточка признаёт scoped credential кастомного OAuth-окружения', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-scoped-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const kimiHome = path.join(root, '.kimi-code');
  const credentials = path.join(kimiHome, 'credentials');
  await fs.mkdir(credentials, { recursive: true });

  const config = { kimiBin: 'kimi', kimiHome };

  // Похожие имена (каталог, чужой файл, hash не из hex) авторизацией не считаются.
  await fs.mkdir(path.join(credentials, 'kimi-code-env-aa11bb22cc33dd44.json.d'));
  await fs.writeFile(path.join(credentials, 'kimi-code-env.json'), 'не читать');
  await fs.writeFile(path.join(credentials, 'kimi-code.json.bak'), 'не читать');
  assert.deepEqual(await kimi.auth(config), {
    mode: 'none',
    label: 'не авторизован (kimi login)',
    available: false,
  });

  await fs.writeFile(
    path.join(credentials, 'kimi-code-env-0e4f99c69cc27850.json'), 'не читать',
  );
  assert.deepEqual(await kimi.auth(config), {
    mode: 'cli',
    label: 'CLI хоста (kimi login)',
    available: true,
  });

  // Официальный слот важнее scoped: удаление scoped не роняет авторизацию.
  await fs.writeFile(path.join(credentials, 'kimi-code.json'), 'не читать');
  await fs.rm(path.join(credentials, 'kimi-code-env-0e4f99c69cc27850.json'));
  assert.deepEqual(await kimi.auth(config), {
    mode: 'cli',
    label: 'CLI хоста (kimi login)',
    available: true,
  });
});

test('Kimi виден и в setup-, и в runtime-реестре чатов', async () => {
  const registered = (await getProviderAdapters()).get('kimi');

  assert.equal(registered.id, kimi.id);
  assert.equal(registered.externalCli, kimi.externalCli);
  assert.equal(typeof registered.run, 'function');
  assert.equal(await getExecutor('kimi'), registered);
});

test('Kimi managed usage превращается в недельный/5ч бары и Extra Usage', () => {
  const result = {
    kind: 'ok',
    summary: {
      window: { duration: 1, unit: 'week' }, used: 40, limit: 100,
      reset_at: '2030-01-01T00:00:00.000Z',
    },
    limits: [{ window: { duration: 5, unit: 'hour' }, used: 7, limit: 20 }],
    extra_usage: {
      balance_cents: 1250,
      monthly_charge_limit_enabled: true,
      monthly_charge_limit_cents: 5000,
      monthly_used_cents: 1000,
      currency: 'CNY',
    },
  };
  assert.deepEqual(parseKimiUsageBars(result).map((bar) => [bar.label, bar.pct]), [
    ['Неделя (7д)', 40],
    ['Сессия (5ч)', 35],
  ]);
  const resources = parseKimiUsageResources(result);
  assert.equal(resources[0].summary, 'Баланс: ¥12.50');
  assert.equal(resources[0].percent, 20);
  assert.equal(resources[0].note, 'В этом месяце: ¥10.00 из ¥50.00.');
  assert.deepEqual(resources[0].balance, { amount: 12.5, currency: 'CNY' });
  assert.equal(resources[0].controls[0].href, 'https://www.kimi.com/code/console');
  assert.equal(resources[1].key, 'kimi-monthly-volume');
  assert.equal(resources[1].summary, 'Kimi не сообщает остаток');
  assert.equal(resources[1].percent, undefined);
  assert.equal(classifyKimiUsageResponse({ result }).state, 'ok');
});

test('Kimi без кошелька показывает доплату и месячный объём при полученных окнах', () => {
  for (const extra_usage of [null, undefined]) {
    const result = {
      kind: 'ok',
      summary: null,
      limits: [{
        window: { duration: 5, unit: 'hour' },
        used: 40,
        limit: 100,
      }],
      extra_usage,
    };
    const usage = classifyKimiUsageResponse({ result });

    assert.equal(usage.state, 'ok');
    assert.equal(usage.bars.length, 1);
    assert.deepEqual(usage.resources, [{
      key: 'kimi-extra-usage',
      label: 'Extra Usage',
      summary: 'Не включено или не пополнено',
      tone: 'muted',
      controls: [{
        id: 'enable-kimi-usage',
        kind: 'link',
        label: 'Включить и пополнить в Kimi',
        href: 'https://www.kimi.com/code/console',
      }],
    }, {
      key: 'kimi-monthly-volume',
      label: 'Месячный объём',
      summary: 'Kimi не сообщает остаток',
      tone: 'muted',
      controls: [{
        id: 'view-kimi-monthly-volume',
        kind: 'link',
        label: 'Посмотреть в Kimi',
        href: 'https://www.kimi.com/code/console',
      }],
    }]);
  }
});

test('Kimi не выдаёт справочные карточки за данные пустого или неудачного ответа', () => {
  for (const result of [
    {
      kind: 'ok',
      summary: null,
      limits: [],
      extra_usage: null,
    },
    {
      kind: 'ok',
      summary: null,
      limits: [],
    },
    {
      kind: 'error',
      status: 503,
      message: 'Service unavailable',
    },
    null,
  ]) {
    const usage = classifyKimiUsageResponse({ result });

    assert.equal(usage.state, 'unavailable');
    assert.deepEqual(parseKimiUsageResources(result), []);
    assert.deepEqual(usage.resources || [], []);

    if (result?.kind === 'ok') {
      assert.match(usage.message, /Kimi не вернул данные о лимитах/);
    }
  }
});

test('Кошелёк Kimi подтверждает данные и без окон лимитов', () => {
  const usage = classifyKimiUsageResponse({
    result: {
      kind: 'ok',
      extra_usage: {
        balance_cents: 1250,
        monthly_used_cents: 300,
        currency: 'CNY',
      },
    },
  });

  assert.equal(usage.state, 'ok');
  assert.deepEqual(usage.bars, []);
  assert.equal(usage.resources[0].key, 'kimi-extra-usage');
  assert.equal(usage.resources[0].summary, 'Баланс: ¥12.50');
  assert.equal(usage.resources[0].note, 'В этом месяце: ¥3.00; месячный потолок не задан.');
  assert.equal(usage.resources[1].key, 'kimi-monthly-volume');
});

test('Именованные лимиты Kimi различимы и живут своими вёдрами', () => {
  // Узнаваемое окно проверялось первым, поэтому два именованных недельных лимита
  // рисовались двумя одинаковыми строками «Неделя (7д)» — различить их было нечем.
  const bars = parseKimiUsageBars({
    kind: 'ok',
    summary: { window: { duration: 1, unit: 'week' }, used: 40, limit: 100 },
    limits: [
      { window: { duration: 5, unit: 'hour' }, used: 7, limit: 20 },
      { window: { duration: 1, unit: 'week' }, used: 1, limit: 10, name: 'k2-reserve' },
      { window: { duration: 3, unit: 'day' }, used: 1, limit: 10, name: 'превью' },
    ],
  });

  assert.deepEqual(bars.map((bar) => [bar.label, bar.group]), [
    ['Неделя (7д)', 'subscription'],
    ['Сессия (5ч)', 'subscription'],
    ['Неделя · k2-reserve', 'named:k2-reserve'],
    // У вычисленного окна длительность и есть весь смысл подписи, поэтому остаётся.
    ['Окно (3д) · превью', 'named:превью'],
  ]);
});

test('Kimi usage различает истёкший login и пустой ответ', () => {
  const auth = classifyKimiUsageResponse({
    result: { kind: 'error', status: 401, message: 'Authorization failed' },
  });
  assert.equal(auth.state, 'auth_required');
  assert.equal(auth.action.command, 'kimi login');
  assert.equal(classifyKimiUsageResponse({ result: { kind: 'ok', summary: null, limits: [] } }).state, 'unavailable');
  assert.match(
    classifyKimiUsageResponse({ reason: 'startup_timeout' }).message,
    /не успел запуститься/i,
  );
});

test('Kimi usage распознаёт фактический silent-баннер 0.31.1 и старую компактную строку', () => {
  const silentBanner = [
    '  Kimi server ready  0.31.1',
    '  Local:    http://127.0.0.1:43123/#token=super%20secret',
    '  Network:  off  use --host to enable',
  ].join('\n');
  assert.deepEqual(parseReadyUrl(silentBanner), {
    origin: 'http://127.0.0.1:43123',
    token: 'super secret',
  });
  assert.deepEqual(
    parseReadyUrl('Kimi server: http://127.0.0.1:43124/#token=compact%20secret\n'),
    { origin: 'http://127.0.0.1:43124', token: 'compact secret' },
  );
  assert.equal(parseReadyUrl('Local: http://0.0.0.0:43123/#token=unsafe'), null);
  assert.equal(parseReadyUrl('Local: http://127.0.0.1:43123/'), null);
});

test('Kimi usage broker не возвращает bearer token и штатно закрывает child', async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-usage-'));
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  let child;
  let spawnArgs;
  const spawnProcess = (bin, args, options) => {
    spawnArgs = { bin, args, options };
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = 'SIGTERM';
      child.emit('close', null, 'SIGTERM');
    };
    queueMicrotask(() => child.stdout.write(
      [
        '  Kimi server ready  0.31.1',
        '  Local:    http://127.0.0.1:43123/#token=super%20secret',
        '  Network:  off  use --host to enable',
      ].join('\n'),
    ));
    return child;
  };
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith('/api/v1/shutdown')) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('close', 0, null));
      return { ok: true, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({ data: { kind: 'ok', summary: null, limits: [], extra_usage: null } }),
    };
  };

  const result = await requestKimiManagedUsage({
    kimiBin: '/opt/kimi/bin/kimi',
    kimiHome: '/home/user/.kimi-code',
    kimiRuntimeHome: runtimeRoot,
    rootDir: '/workspace',
  }, { spawnProcess, fetchImpl });

  assert.deepEqual(result, {
    result: { kind: 'ok', summary: null, limits: [], extra_usage: null },
  });
  assert.equal(JSON.stringify(result).includes('super secret'), false);
  assert.equal(spawnArgs.options.cwd, path.join(runtimeRoot, 'usage-work'));
  assert.equal(spawnArgs.options.env.KIMI_CODE_CACHE_DIR, path.join(runtimeRoot, 'usage-cache'));
  assert.deepEqual(spawnArgs.args.slice(0, 3), ['web', '--host', '127.0.0.1']);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer super secret');
  assert.equal(requests[1].url, 'http://127.0.0.1:43123/api/v1/shutdown');
  assert.equal(child.exitCode, 0);
});


test('Kimi сохраняет сотые процента и убирает шум деления', () => {
  for (const [used, limit, expected] of [
    [996, 1000, 99.6],
    [1, 3, 33.33],
    [29, 100, 29],
    [0, 100, 0],
    [6, 100, 6],
    [28, 100, 28],
    [100, 100, 100],
    [130, 100, 100],
  ]) {
    const bars = parseKimiUsageBars({ kind: 'ok', summary: { used, limit } });

    assert.equal(bars.length, 1);
    assert.ok(Math.abs(bars[0].pct - expected) < 1e-9, `${used}/${limit}: ${bars[0].pct}`);
  }
});


test('Kimi не превращает отсутствующий расход и неверный лимит в полосу', () => {
  for (const used of [undefined, null, '', true, -5, '996', NaN, Infinity]) {
    const bars = parseKimiUsageBars({ kind: 'ok', summary: { used, limit: 1000 } });

    assert.equal(bars.some((bar) => bar.key === 'kimi:0:0:limit'), false, String(used));
  }

  for (const limit of [undefined, null, '', true, 0, -1, '100', NaN, Infinity]) {
    const bars = parseKimiUsageBars({ kind: 'ok', summary: { used: 1, limit } });

    assert.equal(bars.some((bar) => bar.key === 'kimi:0:0:limit'), false, String(limit));
  }
});

test('Kimi quota.usages сохраняет ноль, календарный месяц и единицы кошелька', () => {
  const result = {
    kind: 'ok',
    quota: {
      usages: {
        limit5h: { usedRatio: 0, resetAt: '2030-01-01T10:00:00Z' },
        limit7d: { usedRatio: 0.125, resetAt: 'invalid' },
        monthTotal: { usedRatio: 0.4 },
        monthCode: { usedRatio: 0.2 },
      },
      extraUsage: {
        balanceCents: 1250,
        totalCents: 2000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 5000,
        monthlyUsedCents: 300,
        currency: 'USD',
      },
    },
  };
  const usage = classifyKimiUsageResponse({ result });
  const bars = parseKimiUsageBars(result);
  const resources = parseKimiUsageResources(result);

  assert.equal(usage.state, 'ok');
  assert.deepEqual(bars.map((bar) => [bar.label, bar.pct]), [
    ['Сессия (5ч)', 0],
    ['Неделя (7д)', 12.5],
    ['Месяц', 40],
  ]);
  assert.equal(bars[0].resetsAt, '2030-01-01T10:00:00.000Z');
  assert.equal(bars[1].resetsAt, null);
  assert.equal(bars[2].windowMinutes, undefined);
  assert.deepEqual(resources[0].balance, { amount: 12.5, currency: 'USD' });
  assert.equal(resources[0].percent, 6);
  assert.equal(resources[1].summary, 'Израсходовано за месяц: 40%');
  assert.equal(resources[1].note, 'Из них код: 20% месячной квоты');
  assert.equal(resources[1].percent, undefined);
});

test('Kimi новая quota имеет приоритет без дублирования старых полос и баланса', () => {
  const result = {
    kind: 'ok',
    summary: {
      used: 99,
      limit: 100,
      window: { duration: 1, unit: 'week' },
    },
    limits: [{
      used: 88,
      limit: 100,
      window: { duration: 5, unit: 'hour' },
    }],
    extra_usage: { balance_cents: 9900, currency: 'CNY' },
    quota: {
      usages: { limit7d: { usedRatio: 0.3 }, limit5h: { usedRatio: 0.2 } },
      extraUsage: null,
    },
  };

  assert.deepEqual(parseKimiUsageBars(result).map((bar) => bar.pct), [20, 30]);
  assert.deepEqual(parseKimiUsageBars(result).map((bar) => bar.key), [
    'kimi:1:5:hour', 'kimi:0:1:week',
  ]);
  assert.equal(parseKimiUsageResources(result)[0].kind, undefined);
});

test('Kimi отвергает нечисловые ratios и не выдаёт пустую новую quota за успех', () => {
  for (const usedRatio of [undefined, null, '0.5', -1, Number.NaN, Infinity]) {
    const result = { kind: 'ok', quota: { usages: { limit5h: { usedRatio } }, extraUsage: {} } };

    assert.deepEqual(parseKimiUsageBars(result), []);
    assert.deepEqual(parseKimiUsageResources(result), []);
    assert.equal(classifyKimiUsageResponse({ result }).state, 'unavailable');
  }

  const over = { kind: 'ok', quota: { usages: { limit5h: { usedRatio: 1.4 } } } };

  assert.equal(parseKimiUsageBars(over)[0].pct, 100);
  assert.deepEqual(parseKimiUsageBars({ ...over, kind: 'error' }), []);
});

test('Kimi принимает новый кошелёк без полос и старый ответ при неизвестной quota', () => {
  const wallet = {
    kind: 'ok',
    quota: { extraUsage: {
      balanceCents: 0,
      monthlyUsedCents: 0,
      currency: 'USD',
    } },
  };
  const legacy = {
    kind: 'ok',
    quota: { futureShape: true },
    summary: { used: 2, limit: 10 },
  };

  assert.equal(classifyKimiUsageResponse({ result: wallet }).state, 'ok');
  assert.deepEqual(parseKimiUsageBars(wallet), []);
  assert.deepEqual(parseKimiUsageResources(wallet)[0].balance, { amount: 0, currency: 'USD' });
  assert.equal(parseKimiUsageBars(legacy)[0].pct, 20);
});

test('kimi сжимает контекст выжимкой, а не слэш-командой web-транспорта', async () => {
  // Web-протокол Kimi не исполняет '/compact' локально: текст уходит модели как
  // обычное сообщение (docs/grigdesk/chat/context-wheel-executor-gaps.md), кнопка
  // кольца при этом обещала сжатие. План summary — тот же путь, что у DeepSeek/GLM.
  assert.deepEqual(kimi.compaction, { kind: 'summary' });
});
