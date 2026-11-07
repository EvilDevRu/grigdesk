// Ручной live smoke pinned DSH: запускать только с DEEPSEEK_API_KEY в окружении.
// Всё состояние CLI создаётся под переданным workspace-каталогом.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import deepseek from '../../../server/src/lib/executors/deepseek.ts';

const root = path.resolve(process.argv[2] || '');
const bin = path.resolve(process.argv[3] || '');

if (!process.env.DEEPSEEK_API_KEY || !root || !bin) {
  throw new Error('Нужны DEEPSEEK_API_KEY, каталог результата и pinned dsh');
}

const work = path.join(root, 'work');
const home = path.join(root, 'home');
const cache = path.join(root, 'cache');

for (const directory of [root, work, home, cache]) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 150_000);
const blocks = [];
const steps = [];
let port = null;
let settled = false;
let replyBeforeFinal = false;
const question = 'Зачем нужен файл первого шага?';

const turn = deepseek.run({
  config: { deepseekBin: bin, deepseekRuntimeHome: path.join(root, 'runtime') },
  env: { ...process.env, HOME: home, XDG_CACHE_HOME: cache },
  cwd: work,
  chatKey: 'live-smoke-deepseek',
  message: [
    'В этой тестовой папке выполни два шага строго по порядку.',
    'Шаг 1: инструментом создай файл step-one.txt с текстом ONE.',
    'Затем инструментом выполни команду sleep 20.',
    'Шаг 2: после ожидания инструментом создай файл step-two.txt с текстом TWO.',
    'После второго шага дай короткий итог. Если во время ожидания придёт вопрос,',
    'ответь на него до итога, затем заверши оба шага.',
  ].join(' '),
  model: '["deepseek-official","deepseek-v4-flash"]',
  permissionMode: 'default',
  providerSettings: { blockDirectSsh: true, blockDirectDb: false },
  signal: abort.signal,
  onStep(step) { steps.push({ kind: step.k, name: step.name || step.tool || '' }); },
  onInTurnReady(given) { port = given; },
  onAssistantMessage(event) {
    if (event.complete) {
      blocks.push(event.text);
      if (!settled && blocks.length === 1) replyBeforeFinal = true;
    }
  },
  async onPermission() { return { allow: false }; },
}).finally(() => { settled = true; });

try {
  let foundFirst = false;

  for (let attempt = 0; attempt < 600 && !settled; attempt += 1) {
    if (port && await fs.stat(path.join(work, 'step-one.txt')).then(() => true, () => false)) {
      foundFirst = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!foundFirst || settled) {
    throw new Error('Не удалось найти безопасное окно после первого шага');
  }

  const delivery = await port.deliver({
    messageId: 'message-live-12345', text: question, sequence: 1,
  });
  const result = await turn;
  const second = await fs.readFile(path.join(work, 'step-two.txt'), 'utf8').catch(() => '');
  const report = {
    version: '0.1.5-rc.2',
    transport: 'web/remote.mux',
    delivery,
    replyBeforeFinal,
    blocks,
    final: result.reply,
    secondStep: second.trim(),
    stepCount: steps.length,
    toolNames: [...new Set(steps.filter((step) => step.kind === 'tool').map((step) => step.name))],
  };

  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({
    delivered: delivery.ok,
    replyBeforeFinal,
    secondStep: second.trim() === 'TWO',
    answerWithoutContinueWord: !!blocks[0]
      && !blocks[0].toLowerCase().includes('продолжай'),
  }));
  if (!delivery.ok || !replyBeforeFinal || second.trim() !== 'TWO'
    || !blocks[0] || blocks[0].toLowerCase().includes('продолжай')) {
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timeout);
  abort.abort();
}
