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

test('Kimi виден и в setup-, и в runtime-реестре чатов', async () => {
  assert.equal((await getProviderAdapters()).get('kimi'), kimi);
  assert.equal(await getExecutor('kimi'), kimi);
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
  assert.equal(resources[0].controls[0].href, 'https://www.kimi.com/code/console');
  assert.equal(classifyKimiUsageResponse({ result }).state, 'ok');
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
