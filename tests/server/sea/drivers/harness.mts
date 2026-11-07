import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AuthStore } from '../../../../server/src/lib/authStore.ts';
import { environment, freePort, ready, tracked } from './common.mts';

/**
 * Поднимает настоящий ELF с синтетической cookie и независимыми портами.
 * Перед запуском вызывающий готовит только временный D, окружение строится по allowlist.
 */
export async function server(root: string, extra: NodeJS.ProcessEnv = {}, ipc = false) {
  const port = await freePort();
  let mobile = await freePort();

  while (mobile === port) {
    mobile = await freePort();
  }

  const store = new AuthStore({
    legacyAccountPath: '/D/state/auth.json',
    sessionsPath: '/D/state/sessions.json',
  });
  const headers = {
    cookie: `grigdesk_sid=${store.createSession().id}`,
    Origin: `http://127.0.0.1:${port}`,
  };
  const env = {
    ...environment(),
    GRIGDESK_PORT: String(port),
    GRIGDESK_MOBILE_PORT: String(mobile),
    ...extra,
  };
  const run = tracked(path.join(root, 'server/grigdesk-server'), [], env, ipc);

  try {
    await ready(run, port);
  } catch (error) {
    await run.stop();

    throw error;
  }

  return {
    ...run,
    env,
    port,
    /**
     * Все запросы идут в собственный loopback сервер; неожиданный HTTP — отказ.
     * Диагностика содержит ответ API и лог собственного SEA, без данных хоста.
     */
    async request(route: string, method = 'GET', body?: unknown, status = 200): Promise<any> {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();

      assert.equal(response.status, status, `${route}: ${text}\n${run.log()}`);

      return JSON.parse(text);
    },
  };
}

/**
 * Записывает prefs до boot; пользовательские плагины включаются явным значением.
 * Проекты фикстуры не связаны с фабрикой либо путями настоящей установки.
 */
export async function preferences(plugins: Record<string, boolean> = {}) {
  await mkdir('/D/state', { recursive: true });
  await writeFile('/D/state/prefs.json', JSON.stringify({
    projects: { fixture: { title: 'Fixture', repos: [] } },
    plugins: { db: true, ...plugins },
  }));
}
