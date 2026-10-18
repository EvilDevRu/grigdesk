// Отсоединённый исполнитель установки браузера записи.
//
// Три шага по порядку: скачать Chromium сборкой под текущий playwright-core в
// каталог GrigDesk, спросить у самого Playwright путь к исполняемому файлу и
// ПРОВЕРИТЬ, что он запускается. Последний шаг обязателен: скачанный архив
// браузером ещё не является, а «установлен, но не стартует» человек разбирал бы
// дольше, чем честный отказ с текстом ошибки загрузчика.
//
// Манифест пишется только после проверки и запоминает версию Playwright: по ней
// сервер отличает актуальную установку от оставшейся с прошлого обновления.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { createAttemptLog } from '../src/lib/showcase/attemptLog.ts';

const run = promisify(execFile);

interface InstallTask {
  attemptId: string;
  workDir: string;
  browsersDir: string;
  manifestFile: string;
  cli: string;
  playwrightVersion: string;
  deadlineMs: number;
}

const taskFile = process.argv[2];

if (!taskFile) {
  console.error('showcaseBrowserInstall: не передан файл задания');
  process.exit(2);
}

const task = JSON.parse(await readFile(taskFile, 'utf8')) as InstallTask;
const { finish, report } = createAttemptLog(task);

// Каталог браузеров задаётся ДО импорта playwright-core: путь читается при
// загрузке модуля, и позже его уже не переубедить.
process.env.PLAYWRIGHT_BROWSERS_PATH = task.browsersDir;

async function fail(message: string): Promise<never> {
  await finish({ state: 'failed', error: message });
  process.exit(1);
}

const deadline = setTimeout(() => {
  void fail('срок установки истёк');
}, task.deadlineMs);

deadline.unref();

/**
 * Долгая команда с живым журналом. Весь вывод уходит в лог попытки, а в строку
 * прогресса — последняя содержательная строка не чаще раза в две секунды: человеку
 * нужен признак движения, а не поток загрузчика.
 */
async function runLong(command: string, args: string[], step: string, label: string): Promise<void> {
  await report(step, label);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let reportedAt = 0;

    const observe = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');

      process.stdout.write(text);

      const line = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1);
      // У загрузчика Playwright строка — это полоса из символов и проценты; в
      // прогресс уходят только проценты, полосу человек и так видит в интерфейсе.
      const progress = line ? /(\d+% of [\d.]+ \w+)/.exec(line)?.[1] : undefined;

      if (line) {
        tail = (progress ?? line).slice(0, 160);
      }

      if (line && Date.now() - reportedAt > 2000) {
        reportedAt = Date.now();
        void report(step, `${label}: ${tail}`);
      }
    };

    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();

        return;
      }

      reject(new Error(`${command} завершился с кодом ${code}: ${tail}`));
    });
  });
}

try {
  await mkdir(task.browsersDir, { recursive: true, mode: 0o700 });
  await runLong(
    process.execPath,
    [task.cli, 'install', 'chromium', '--no-shell'],
    'download',
    'скачиваю Chromium',
  );

  const { chromium } = await import('playwright-core');
  const executable = chromium.executablePath();
  const present = await stat(executable).then((info) => info.isFile(), () => false);

  if (!present) {
    await fail(`Playwright не оставил исполняемого файла: ${executable}`);
  }

  await report('check', 'проверяю запуск браузера');

  const { stdout } = await run(executable, ['--version'], { timeout: 60_000 }).catch(
    (error: { stderr?: string; message: string }) => {
      throw new Error(`браузер не запускается: ${(error.stderr || error.message).trim().slice(-300)}`);
    },
  );
  const browserVersion = stdout.trim();

  if (!/chrom/i.test(browserVersion)) {
    await fail(`браузер ответил не своей версией: ${browserVersion.slice(0, 120)}`);
  }

  const temporary = `${task.manifestFile}.tmp`;

  await writeFile(
    temporary,
    `${JSON.stringify({
      schemaVersion: 1,
      executable,
      playwrightVersion: task.playwrightVersion,
      browserVersion,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await rename(temporary, task.manifestFile);
  await report('done', `браузер готов: ${browserVersion}`);
  await finish({ state: 'succeeded', executable, browserVersion });
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}

clearTimeout(deadline);
