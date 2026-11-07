// Ручной smoke установленного Codex: новый thread и два файловых шага в fixture workspace.
// CLI получает существующий вход по ссылке, а config и новые сессии держит отдельно.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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

// Режим image передаёт уточнение с картинкой: цвет не назван в тексте, его видно
// только на самом изображении, поэтому верный ответ доказывает доставку картинки.
const question = mode === 'image'
  ? 'Какого цвета приложенная картинка? Ответ начни словами «Ответ на уточнение:».'
  : 'Зачем нужен step-one.txt в этой проверке? Ответ начни словами «Ответ на уточнение:».';
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
const task = mode === 'file' || mode === 'files' ? fileTask : textTask;
const textual = task === textTask;

/**
 * Однотонный PNG без зависимостей: IHDR, одна строка IDAT на пиксельную строку, IEND.
 * Красный квадрат 64×64 — цвет, который модель назовёт только глядя на картинку.
 */
function solidPng(size, [red, green, blue]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;

    for (const byte of buffer) {
      c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }

    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    const tail = Buffer.alloc(4);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);

    head.writeUInt32BE(data.length);
    tail.writeUInt32BE(crc(body));

    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(Buffer.from([red, green, blue]))]);

  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const imagePath = path.join(root, 'reference.png');

if (mode === 'image') {
  await fs.writeFile(imagePath, solidPng(64, [220, 20, 20]));
}

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
  await waitFor(async () => textual
    ? port && blocks.some((block) => block.text.includes('ЭТАП 1 ГОТОВ'))
    : port && await exists(path.join(work, 'step-one.txt')),
  textual ? 'порт и первый этап' : 'порт и первый файл');

  const delivery = await port.deliver({
    messageId: 'message-codex-live-0001',
    text: question,
    sequence: 1,
    ...(mode === 'image' ? { images: [{ path: imagePath }] } : {}),
  });
  const answer = await waitFor(
    () => blocks.find((block) => block.beforeFinal && block.text.includes('Ответ на уточнение:')),
    'ответ на уточнение до финала',
  );
  const result = await run;
  const second = await fs.readFile(path.join(work, 'step-two.txt'), 'utf8').catch(() => '');
  const answerCopies = blocks.filter((block) => block.id === answer.id).length;
  const sawImage = mode !== 'image' || /красн/i.test(answer.text);
  const success = delivery.ok === true
    && answer.beforeFinal
    && answerCopies === 1
    && sawImage
    && (textual
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
    sawImage,
    secondStep: textual
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
