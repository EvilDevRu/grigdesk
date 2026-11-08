import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { api as sharedApi } from '../../web/src/shared/apiClient.ts';
import { resolveChatWorkdir } from '../../server/src/lib/chat/workdir.ts';

/**
 * WA07 остаётся проверкой общего transport ядра, а продуктовая API suite живёт в плагине.
 * Fake fetch не обращается к сети: abort/deadline и запрет повторного GET остаются реальными.
 */
test('WA-07 retained core: consumer abort сохраняет deadline и не повторяет отменённый GET', async (t) => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;

  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    calls += 1;

    const signal = options.signal;

    signal.addEventListener('abort', () => reject(signal.reason), { once: true });

    if (signal.aborted) {
      reject(signal.reason);
    }
  });

  const fallback = setTimeout(() => controller.abort(), 150);

  t.after(() => {
    clearTimeout(fallback);
    globalThis.fetch = previousFetch;
  });
  await assert.rejects(sharedApi.get('/api/ext/studio3d/state', {
    retry: false,
    signal: controller.signal,
    timeoutMs: 5,
  }), (error) => error.name === 'TimeoutError');
  assert.equal(calls, 1);
});

/**
 * WL05 сохраняет настоящий resolver внешней папки в ядре, без импорта исходников продукта.
 * Public askAgent request/draft/capability assertions остаются в перенесённой P mounted suite.
 */
test('WL-05 retained core: штатный resolver допускает внешнюю библиотеку без проекта', async (t) => {
  const artifacts = process.env.GRIGDESK_ARTIFACTS_DIR ?? path.join(os.homedir(), '.grigdesk/artifacts');

  await fs.mkdir(path.join(artifacts, 'studio3d-extraction'), { recursive: true });

  const directory = await fs.mkdtemp(path.join(artifacts, 'studio3d-extraction', 'core-workdir-'));
  const grigdesk = path.join(directory, 'grigdesk');
  const modelDirectory = path.join(directory, 'library', 'hero');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(grigdesk, { recursive: true });
  await fs.mkdir(modelDirectory, { recursive: true });

  const result = await resolveChatWorkdir({
    workdir: { kind: 'path', path: modelDirectory },
    provider: 'offline',
    caps: { switch: 'resume', roots: 'multi' },
    config: { rootDir: grigdesk, profilesDir: path.join(grigdesk, 'profiles') },
    prefs: { read: () => ({ projects: {} }) },
    factoryState: { readEnv: async () => ({}) },
    trustedProject: async () => null,
  });

  assert.deepEqual(result.workdir, { kind: 'path', path: modelDirectory });
  assert.equal(result.cwd, await fs.realpath(modelDirectory));
  assert.equal(result.source, 'path');
  assert.deepEqual(result.extraDirs, []);
});
