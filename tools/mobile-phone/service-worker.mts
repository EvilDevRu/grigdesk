import { writeFile, copyFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { createMobileSeed } from '../../tests/helpers/mobileSeed.mjs';

const metadataFile = process.argv[2]!;
const rootDirectory = process.argv[3] || null;
const cleanup: Array<() => Promise<void> | void> = [];
const scope = { after: (callback: () => Promise<void> | void) => cleanup.unshift(callback) };
const seed = await createMobileSeed(scope, { rootDirectory });

await seed.core.listen({
  host: '127.0.0.1',
  port: 0,
});
await writeFile(
  metadataFile,
  JSON.stringify({
    root: seed.root,
    httpPort: seed.core.server.address().port,
    cliToken: seed.cliToken,
  }),
  { mode: 0o600 },
);

const input = createInterface({ input: process.stdin });
let answer: Promise<unknown> | null = null;
let work = Promise.resolve();

/**
 * IPC контролирует только синтетические внешние зависимости: LLM и портал не настоящие.
 * Chat admission, история, TLS, idempotency journal и административный API остаются производственными.
 */
async function command(value: {
  id: number;
  action: string;
  count?: number;
}) {
  let result: unknown = {};

  if (value.action === 'release') {
    await seed.waitForRuns(value.count || 1, 35000);

    const icon = path.join(seed.root, 'image.png');

    await copyFile(path.resolve('mobile/public/icon-192.png'), icon);

    // Шаг Read в форме настоящих исполнителей: вызов и итог — отдельные записи с общим id.
    seed.runs
      .at(-1)!
      .release(
        `Ответ без браузера\n\`\`\`sh\nprintf 'Тестовая команда'\n\`\`\`\n` +
          `![Картинка](${icon})`,
        {
          steps: [
            {
              k: 'tool',
              id: 'e2e-read-image',
              name: 'Read',
              title: 'image.png',
              sub: icon,
              at: Date.now(),
            },
            {
              k: 'res',
              id: 'e2e-read-image',
              ok: true,
              text: '[изображение]',
              lines: 1,
              at: Date.now(),
            },
          ],
        },
      );

    const deadline = Date.now() + 3000;

    while (Date.now() < deadline) {
      const chat = await seed.core.mobileChat.read('integration-chat');

      if (chat.messages.some((item: { role: string }) => item.role === 'assistant')) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } else if (value.action === 'ask') {
    await seed.waitForRuns(value.count || 1);
    answer = seed.runs.at(-1)!.ask({
      tool: 'Question',
      questions: [
        {
          question: 'Продолжить проверку?',
          header: 'Решение',
          options: [{ label: 'Да' }, { label: 'Нет' }],
        },
      ],
      isQuestion: true,
      acceptsText: true,
    });
  } else if (value.action === 'answer') {
    result = await answer;
  } else if (value.action === 'runs') {
    result = { count: seed.runs.length };
  } else if (value.action === 'close') {
    input.close();

    for (const close of cleanup) {
      await close();
    }
  } else {
    throw new Error('Неизвестная команда стенда');
  }

  process.stdout.write(
    JSON.stringify({
      id: value.id,
      ok: true,
      result,
    }) + '\n',
  );
}

input.on('line', (line) => {
  const value = JSON.parse(line);

  work = work
    .then(() => command(value))
    .catch((failure) => {
      const reason =
        failure instanceof Error &&
        /^исполнитель получил \d+ запусков из \d+$/.test(failure.message)
          ? failure.message
          : 'Внешняя зависимость отказала';

      process.stdout.write(
        JSON.stringify({
          id: value.id,
          ok: false,
          action: value.action,
          reason,
        }) + '\n',
      );
    });
});
process.stdout.write('ready\n');
