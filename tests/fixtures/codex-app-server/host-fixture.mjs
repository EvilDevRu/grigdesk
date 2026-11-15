import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import codex from '../../../server/src/lib/executors/codex.ts';

const fixtureUrl = new URL('./permission-modes-0.167.1.mjs', import.meta.url).href;

/**
 * Каждый тест владеет отдельными CLI, настройками и журналом; пользовательский HOME не читается.
 * Пустой журнал допустим до первого spawn, поэтому отсутствие scope даёт assertion, а не ENOENT.
 */
export async function hostFixture(t, initial = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-host-'));
  const cwd = path.join(root, 'workspace');
  const bin = path.join(root, 'codex');
  const trace = path.join(root, 'trace.jsonl');
  const settings = path.join(root, 'settings.json');
  const config = {
    codexBin: bin,
    dataHome: path.join(root, 'data'),
    rootDir: cwd,
  };
  let state = initial;
  const resources = [];

  await mkdir(cwd);
  await writeFile(trace, '');
  await writeFile(settings, JSON.stringify(state));
  await writeFile(bin, [
    `#!${process.execPath}`,
    `import { runPermissionModesFixture } from ${JSON.stringify(fixtureUrl)};`,
    `runPermissionModesFixture(${JSON.stringify({
      trace,
      settings,
    })});`,
    '',
  ].join('\n'));
  await chmod(bin, 0o755);
  t.after(async () => {
    for (const close of resources.reverse()) {
      await close();
    }

    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  return {
    root,
    cleanup: (close) => resources.push(close),
    cwd,
    bin,
    config,
    trace,
    async update(patch) {
      state = {
        ...state,
        ...patch,
      };
      await writeFile(settings, JSON.stringify(state));
    },
    async messages() {
      return (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    /**
     * Подготовка получает server-owned контекст, отдельный от входа рабочего send.
     * Только полученный здесь handle вправе закреплять профиль ordinary-чата.
     */
    async prepare({ host = true, mode = 'auto', consumer = 'ordinary-chat', ...extra } = {}) {
      const providerSettings = {
        allowHostAccess: host,
        blockDirectSsh: false,
      };
      const context = {
        provider: 'codex',
        chatId: 'host-chat',
        consumer,
        cwd,
        extraDirs: [],
        mode,
        providerSettings,
        ...extra,
      };
      const preparedRuntime = await codex.prepareRuntime(config, {
        signal: AbortSignal.timeout(5000),
        permissionModeContext: context,
      });

      return {
        config,
        cwd,
        extraDirs: [],
        model: 'fixture-model',
        effort: 'high',
        providerSettings,
        permissionMode: mode,
        preparedRuntime,
        runtimeProfileFingerprint: codex.runtimeProfileFingerprint(preparedRuntime),
        tokenInfoReader: async () => null,
        ...(extra.workspaceAccess ? { workspaceAccess: extra.workspaceAccess } : {}),
        ...(extra.modeSelection ? { modeSelection: extra.modeSelection } : {}),
      };
    },
  };
}

/**
 * Ожидаем наблюдаемое событие с ограниченным сроком, без бесконечного зависания фикстуры.
 * При отказе хода вызывающий получает исходную ошибку отдельно, а не ложное подтверждение.
 */
export async function until(check, description) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await pause(10);
  }

  throw new Error(`Не наступило событие фикстуры: ${description}`);
}
