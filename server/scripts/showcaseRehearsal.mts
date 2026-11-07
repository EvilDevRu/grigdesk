// Отсоединённый проход по стенду. Секрет входа стирается до открытия браузера,
// а общий срок закрывает браузер даже при исчезновении ожидающего сервера.
import { readFile, writeFile } from 'node:fs/promises';

import { createAttemptLog } from '../src/lib/showcase/attemptLog.ts';
import { startEgressGuard } from '../src/lib/showcase/browserPolicy.ts';
import { launchBrowser, loginToStand } from '../src/lib/showcase/render/recorder.ts';
import type { LoginRecipe, StorageState } from '../src/lib/showcase/render/recorder.ts';
import { rehearseScript } from '../src/lib/showcase/script/rehearsal.ts';
import type { RehearsalInput } from '../src/lib/showcase/script/rehearsal.ts';
import type { Browser } from 'playwright-core';

type Task = Omit<RehearsalInput, 'browser' | 'loginState'> & {
  attemptId: string;
  browserPath: string;
  login: LoginRecipe | null;
};

const taskFile = process.argv[2];

if (!taskFile) {
  throw new Error('Не передан файл задания проверки сценария.');
}

const task = JSON.parse(await readFile(taskFile, 'utf8')) as Task;
const log = createAttemptLog(task);

if (task.login) {
  await writeFile(taskFile, JSON.stringify({ ...task, login: null }), { mode: 0o600 });
}

const guard = await startEgressGuard({
  allowedOrigins: task.allowedOrigins,
  allowedMethods: [...new Set([...task.allowedMethods, ...(task.login ? ['POST'] : [])])],
});
let browser: Browser | null = null;
let deadline: ReturnType<typeof setTimeout> | null = null;

try {
  browser = await launchBrowser({ executablePath: task.browserPath, proxyPort: guard.port });
  deadline = setTimeout(() => {
    void browser?.close();
  }, 10 * 60 * 1000);
  await log.report('running', 'проверяем сценарий на живом интерфейсе');
  let loginState: StorageState | null = null;

  if (task.login) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        loginState = await loginToStand({
          browser,
          baseUrl: task.baseUrl,
          allowedOrigins: task.allowedOrigins,
          style: task.style,
          login: task.login,
          diagnosticsDir: task.workDir,
        });
        break;
      } catch (error) {
        if (attempt === 1) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  const result = await rehearseScript({ ...task, browser, loginState });

  await log.finish({ state: 'succeeded', ...result });
} catch (error) {
  await log.finish({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
} finally {
  if (deadline) {
    clearTimeout(deadline);
  }

  await browser?.close().catch(() => null);
  await guard.close();
}
