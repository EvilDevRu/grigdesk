// Ручной smoke установленного Codex: новый thread и два файловых шага в fixture workspace.
// CLI получает существующий вход по ссылке, а config и новые сессии держит отдельно.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import codex from '../../../server/src/lib/executors/codex.ts';

const resultRoot = process.argv[2];
const binary = process.argv[3];
const mode = process.argv[4] || 'files';

if (!resultRoot || !binary) {
  throw new Error('Нужны fixture workspace и путь к установленному codex');
}

process.umask(0o077);

const root = path.resolve(resultRoot);
const work = path.join(root, 'work');
const home = path.join(root, 'home');
const cache = path.join(root, 'cache');
const codexHome = path.join(root, 'codex-home');
const authLink = path.join(codexHome, 'auth.json');
const runtime = path.join(root, 'runtime');
const temp = path.join(root, 'tmp');

for (const directory of [root, work, home, cache, codexHome, runtime, temp]) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

// Содержимое auth.json не читаем: его открывает только установленный CLI. Новый
// CODEX_HOME не видит реальные config.toml и sessions текущего пользователя.
await fs.symlink(
  path.join(os.homedir(), '.codex', 'auth.json'),
  authLink,
);

const runtimeEnv = {
  ...process.env,
  HOME: home,
  XDG_CACHE_HOME: cache,
  XDG_RUNTIME_DIR: runtime,
  TMPDIR: temp,
  CODEX_HOME: codexHome,
};

delete runtimeEnv.CODEX_SESSION_ID;
delete runtimeEnv.CODEX_THREAD_ID;

const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(), 180_000);
const blocks = [];
const steps = [];
let port = null;
let settled = false;
let runError = null;
let runValue = null;

const question = 'Зачем нужен step-one.txt в этой проверке? Ответ начни словами «Ответ на уточнение:».';
const fileTask = [
  'В этой тестовой папке выполни три действия строго по порядку отдельными вызовами инструмента.',
  'Сначала создай step-one.txt с текстом ONE.',
  'Затем отдельным вызовом инструмента выполни команду sleep 25 и дождись её завершения.',
  'После ожидания создай step-two.txt с текстом TWO.',
  'Если во время ожидания придёт вопрос, ответь до финального итога,',
  'а затем самостоятельно заверши все три действия.',
].join(' ');
const textTask = [
  'Выполни в одном ходе два этапа и сохрани порядок сообщений.',
  'Сначала отправь отдельное промежуточное сообщение ровно «ЭТАП 1 ГОТОВ: сумма 1..100 = 5050».',
  'Затем отправь финальный ответ ровно «ЭТАП 2 ГОТОВ: сумма квадратов 1..10 = 385».',
  'Если между этапами придёт вопрос, ответь на него отдельным сообщением до финала,',
  'после чего самостоятельно заверши второй этап.',
  'Файловые инструменты для этой задачи не нужны.',
].join(' ');
const task = mode === 'text' ? textTask : fileTask;

const run = codex.run({
  config: { codexBin: path.resolve(binary) },
  env: runtimeEnv,
  cwd: work,
  extraDirs: [],
  sessionId: null,
  message: task,
  providerSettings: { blockDirectSsh: false, blockDirectDb: false },
  tokenInfoReader: async () => null,
  signal: abort.signal,
  onStep(step) {
    if (step.k === 'tool' || step.k === 'res') {
      steps.push({ kind: step.k, tool: String(step.tool || '') });
    }
  },
  onInTurnReady(given) {
    port = given;
  },
  onAssistantMessage(event) {
    if (event.complete) {
      blocks.push({
        id: event.assistantMessageId,
        text: event.text,
        beforeFinal: !settled,
      });
    }
  },
  onPermission: async () => ({ allow: false }),
});

run.then(
  (value) => {
    settled = true;
    runValue = value;
  },
  (error) => {
    settled = true;
    runError = error;
  },
);

async function exists(file) {
  return fs.stat(file).then(() => true, () => false);
}

/**
 * Ждём наблюдаемую границу хода и проверяем раннее завершение.
 * Таймаут служит защитой от зависшего CLI.
 */
async function waitFor(check, what, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;

  while (Date.now() < until) {
    const found = await check();

    if (found) {
      return found;
    }
    if (settled) {
      throw runError || new Error('Ход завершился до события: ' + what);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Не дождались: ' + what);
}

try {
  await waitFor(async () => mode === 'text'
    ? port && blocks.some((block) => block.text.includes('ЭТАП 1 ГОТОВ'))
    : port && await exists(path.join(work, 'step-one.txt')),
  mode === 'text' ? 'порт и первый этап' : 'порт и первый файл');

  const delivery = await port.deliver({
    messageId: 'message-codex-live-0001',
    text: question,
    sequence: 1,
  });
  const answer = await waitFor(
    () => blocks.find((block) => block.beforeFinal && block.text.includes('Ответ на уточнение:')),
    'ответ на уточнение до финала',
  );
  const result = await run;
  const second = await fs.readFile(path.join(work, 'step-two.txt'), 'utf8').catch(() => '');
  const answerCopies = blocks.filter((block) => block.id === answer.id).length;
  const success = delivery.ok === true
    && answer.beforeFinal
    && answerCopies === 1
    && (mode === 'text'
      ? result.reply.includes('ЭТАП 2 ГОТОВ')
      : second.trim() === 'TWO')
    && !question.toLowerCase().includes('продолжай')
    && !answer.text.toLowerCase().includes('продолжай');

  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({
    version: 'installed',
    transport: 'app-server turn/steer',
    mode,
    delivery,
    answer,
    answerCopies,
    blocks,
    final: result.reply,
    secondStep: second.trim(),
    toolSteps: steps.length,
    success,
  }, null, 2), { mode: 0o600 });

  console.log(JSON.stringify({
    delivered: delivery.ok,
    answerBeforeFinal: answer.beforeFinal,
    answerCopies,
    secondStep: mode === 'text'
      ? result.reply.includes('ЭТАП 2 ГОТОВ')
      : second.trim() === 'TWO',
    answerWithoutContinueWord: !answer.text.toLowerCase().includes('продолжай'),
    success,
  }));

  if (!success) {
    process.exitCode = 1;
  }
} catch (error) {
  await fs.writeFile(path.join(root, 'diagnostic.json'), JSON.stringify({
    error: String(error?.message || error),
    reply: String(runValue?.reply || ''),
    steps,
    blocks,
    portReady: !!port,
    firstFile: await exists(path.join(work, 'step-one.txt')),
    secondFile: await exists(path.join(work, 'step-two.txt')),
  }, null, 2), { mode: 0o600 });

  throw error;
} finally {
  clearTimeout(deadline);
  abort.abort();
  await Promise.race([
    run.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  await fs.unlink(authLink).catch(() => {});
}
