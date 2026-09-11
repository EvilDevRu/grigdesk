// Установка браузера записи: Chromium той ревизии, которую требует playwright-core.
//
// Почему не «найти любой Chrome»: у каждой версии Playwright своя ревизия браузера,
// и чужой бинарник даёт то падающую запись, то пустой клип. Поэтому браузер
// ставится в каталог кокпита сборкой под текущий playwright-core, а манифест
// запоминает, под какую версию он поставлен: обновился Playwright — установка
// считается устаревшей и предлагается заново, а не ломает запись молча.
//
// Скачивание идёт минуты и обязано пережить перезапуск, поэтому работу делает
// отсоединённый процесс, а сервер — единственный писатель состояния: та же схема,
// что у записи и установки голоса. Явный `COCKPIT_SHOWCASE_BROWSER` сильнее
// установленного здесь браузера — это выбор администратора машины.
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processAlive } from './processIdentity.ts';
import { launchWorker, readProgressSince, stopWorker } from './render/runner.ts';
import type { JobIdentity } from './jobs.ts';
import { ShowcaseError } from './errors.ts';

const require = createRequire(import.meta.url);

const WORKER_SCRIPT = fileURLToPath(
  new URL('../../../scripts/showcaseBrowserInstall.mts', import.meta.url),
);

// Скачивание ограничено по времени: без срока оборванная загрузка держала бы
// кнопку занятой навсегда.
const INSTALL_DEADLINE_MS = 20 * 60_000;

// Пакет не экспортирует cli.js как модуль, поэтому путь к нему складывается от
// package.json — единственного файла, который он отдаёт наружу.
const PLAYWRIGHT_PACKAGE = require.resolve('playwright-core/package.json');

export const PLAYWRIGHT_VERSION: string = (
  require(PLAYWRIGHT_PACKAGE) as { version: string }
).version;
export const PLAYWRIGHT_CLI: string = path.join(path.dirname(PLAYWRIGHT_PACKAGE), 'cli.js');

export type BrowserInstallState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

// Манифест установленного браузера: его пишет исполнитель после проверки запуска.
export interface BrowserManifest {
  schemaVersion: number;
  executable: string;
  playwrightVersion: string;
  browserVersion: string;
  installedAt: string;
}

export interface BrowserInstallRecord {
  schemaVersion: number;
  id: string;
  state: BrowserInstallState;
  step: string;
  label: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  identity: JobIdentity;
  workDir: string;
  sequence: number;
}

export interface PublicBrowserInstall {
  id: string;
  state: BrowserInstallState;
  step: string;
  label: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface InstalledBrowser {
  executable: string;
  browserVersion: string;
  playwrightVersion: string;
  // Ревизия совпадает с текущим playwright-core. Иначе браузер есть, но записи с
  // ним верить нельзя, и установка предлагается заново.
  current: boolean;
}

export interface BrowserInstallStatus {
  installed: InstalledBrowser | null;
  playwrightVersion: string;
  job: PublicBrowserInstall | null;
}

export interface BrowserInstallerOptions {
  browserDir: string;
  broadcast?: (event: string, data: unknown) => void;
  nodeBin?: string;
  // Исполнитель подменяется, чтобы жизненный цикл установки — повтор нажатия,
  // отмена, потеря процесса — проверялся без скачивания браузера.
  workerScript?: { file: string; marker: string };
  playwrightVersion?: string;
}

function toPublic(record: BrowserInstallRecord): PublicBrowserInstall {
  return {
    id: record.id,
    state: record.state,
    step: record.step,
    label: record.label,
    error: record.error,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

export function createBrowserInstaller(options: BrowserInstallerOptions) {
  const version = options.playwrightVersion ?? PLAYWRIGHT_VERSION;
  const stateFile = path.join(options.browserDir, 'install.json');
  const manifestFile = path.join(options.browserDir, 'browser.json');
  const browsersDir = path.join(options.browserDir, 'browsers');

  let current: BrowserInstallRecord | null = null;
  let loaded = false;

  async function readManifest(): Promise<BrowserManifest | null> {
    const manifest = await fs.readFile(manifestFile, 'utf8').then(
      (text) => JSON.parse(text) as BrowserManifest,
      () => null,
    );

    if (!manifest || typeof manifest.executable !== 'string') {
      return null;
    }

    const present = await fs.access(manifest.executable).then(() => true, () => false);

    return present ? manifest : null;
  }

  async function installed(): Promise<InstalledBrowser | null> {
    const manifest = await readManifest();

    if (!manifest) {
      return null;
    }

    return {
      executable: manifest.executable,
      browserVersion: manifest.browserVersion,
      playwrightVersion: manifest.playwrightVersion,
      current: manifest.playwrightVersion === version,
    };
  }

  /** Исполняемый файл для записи: только установка под текущий Playwright. */
  async function installedExecutable(): Promise<string | null> {
    const browser = await installed();

    return browser?.current ? browser.executable : null;
  }

  async function persist(record: BrowserInstallRecord | null): Promise<void> {
    current = record;

    if (!record) {
      await fs.rm(stateFile, { force: true });

      return;
    }

    await fs.mkdir(options.browserDir, { recursive: true, mode: 0o700 });

    const temporary = `${stateFile}.tmp`;

    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, stateFile);
  }

  function publish(record: BrowserInstallRecord): void {
    options.broadcast?.('showcase-setup', {
      itemId: 'browser',
      state: record.state,
      step: record.step,
      label: record.label,
      error: record.error,
    });
  }

  async function load(): Promise<BrowserInstallRecord | null> {
    if (loaded) {
      return current;
    }

    loaded = true;
    current = await fs.readFile(stateFile, 'utf8').then(
      (text) => JSON.parse(text) as BrowserInstallRecord,
      () => null,
    );

    return current;
  }

  async function readResult(workDir: string): Promise<{
    state: 'succeeded' | 'failed';
    error?: string;
  } | null> {
    return fs.readFile(path.join(workDir, 'result.json'), 'utf8').then(
      (text) => {
        const parsed = JSON.parse(text) as { state?: string; error?: string };

        return parsed.state === 'succeeded' || parsed.state === 'failed'
          ? (parsed as { state: 'succeeded' | 'failed'; error?: string })
          : null;
      },
      () => null,
    );
  }

  async function finish(
    record: BrowserInstallRecord,
    state: BrowserInstallState,
    label: string,
    error: string | null,
  ): Promise<void> {
    const next: BrowserInstallRecord = {
      ...record,
      state,
      label,
      error,
      finishedAt: new Date().toISOString(),
    };

    await persist(next);
    publish(next);
  }

  /**
   * Опрос идущей установки: новые строки журнала попытки и её итог. Вызывается
   * тем же тактом, что и опрос записи, — отдельного таймера у раздела нет.
   */
  async function poll(): Promise<void> {
    const record = await load();

    if (!record || record.state !== 'running') {
      return;
    }

    const lines = await readProgressSince(record.workDir, record.sequence);

    if (lines.length > 0) {
      const last = lines.at(-1)!;
      const next: BrowserInstallRecord = {
        ...record,
        sequence: last.sequence,
        step: last.state,
        label: last.label,
      };

      await persist(next);
      publish(next);
    }

    const fresh = (await load())!;
    const result = await readResult(record.workDir);

    if (result) {
      if (result.state === 'succeeded') {
        await finish(fresh, 'succeeded', 'браузер установлен', null);
      } else {
        await finish(fresh, 'failed', 'установка не удалась', result.error ?? 'причина неизвестна');
      }

      return;
    }

    if (Date.now() > Date.parse(fresh.deadlineAt)) {
      stopWorker(fresh.identity);
      await finish(fresh, 'failed', 'установка не уложилась в срок', 'срок установки истёк');

      return;
    }

    if (!processAlive(fresh.identity)) {
      await finish(
        fresh,
        'interrupted',
        'установка оборвалась',
        'процесс установки исчез: повторите её, скачанное сохранено',
      );
    }
  }

  async function status(): Promise<BrowserInstallStatus> {
    const record = await load();

    return {
      installed: await installed(),
      playwrightVersion: version,
      job: record ? toPublic(record) : null,
    };
  }

  /**
   * Запуск установки. Повторное нажатие возвращает идущую установку, а не заводит
   * вторую: два скачивания в один каталог портят друг другу файлы.
   */
  async function start(): Promise<BrowserInstallStatus> {
    const record = await load();

    if (record?.state === 'running' && processAlive(record.identity)) {
      return status();
    }

    await fs.mkdir(options.browserDir, { recursive: true, mode: 0o700 });

    const handle = await launchWorker({
      workDir: path.join(options.browserDir, 'install'),
      nodeBin: options.nodeBin,
      script: options.workerScript ?? { file: WORKER_SCRIPT, marker: 'showcaseBrowserInstall' },
      task: {
        browsersDir,
        manifestFile,
        cli: PLAYWRIGHT_CLI,
        playwrightVersion: version,
        deadlineMs: INSTALL_DEADLINE_MS,
      },
    });
    const started: BrowserInstallRecord = {
      schemaVersion: 1,
      id: handle.attemptId,
      state: 'running',
      step: 'start',
      label: 'установка начата',
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      deadlineAt: new Date(Date.now() + INSTALL_DEADLINE_MS).toISOString(),
      identity: handle.identity,
      workDir: handle.workDir,
      sequence: 0,
    };

    await persist(started);
    publish(started);

    return status();
  }

  async function cancel(): Promise<BrowserInstallStatus> {
    const record = await load();

    if (!record || record.state !== 'running') {
      return status();
    }

    stopWorker(record.identity);
    await finish(record, 'cancelled', 'установка отменена', null);

    return status();
  }

  /**
   * Сверка после перезапуска сервера. Идущая установка остаётся под наблюдением,
   * исчезнувшая честно называется оборванной: «идёт» у мёртвого процесса хуже
   * отказа, потому что человек ждёт впустую.
   */
  async function recover(): Promise<void> {
    const record = await load();

    if (!record || record.state !== 'running') {
      return;
    }

    if (processAlive(record.identity)) {
      return;
    }

    await poll();

    const fresh = await load();

    if (fresh?.state === 'running') {
      await finish(fresh, 'interrupted', 'установка оборвалась', 'сервер не нашёл её процесса');
    }
  }

  function assertKnown(): void {
    if (!version) {
      throw new ShowcaseError('browser_install_failed', 'Версия playwright-core неизвестна.', 500);
    }
  }

  assertKnown();

  return { cancel, installed, installedExecutable, poll, recover, start, status };
}

export type BrowserInstaller = ReturnType<typeof createBrowserInstaller>;
