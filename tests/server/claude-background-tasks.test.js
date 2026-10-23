import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openClaudeStreamSession } from '../../server/src/lib/executors/_claudeStream.ts';

const CLI = `
import readline from 'node:readline';

const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);

  if (message.type !== 'user') {
    return;
  }

  const batch = JSON.parse(message.message.content[0].text);

  for (const event of batch.before || []) {
    say(event);
  }

  say({ type: 'result', subtype: 'success', result: 'готово', session_id: 'synthetic-session' });

  for (const event of batch.after || []) {
    say(event);
  }

  say({
    type: 'rate_limit_event',
    rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.29, resetsAt: 1792828800 },
  });
});
`;

const snapshot = (tasks) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
});
const rawTask = (task_id, task_type, description, extra = {}) => ({
  task_id,
  task_type,
  description,
  ...extra,
});

/**
 * Настоящий stream-adapter читает синтетический CLI, не обращаясь к модели или сервисам.
 * Существующий process-hook квот служит барьером чтения после result, без нового managed send.
 */
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-background-tasks-'));
  const file = path.join(dir, 'cli.mjs');
  const received = [];
  const backgrounds = [];
  const busy = [];
  const waiters = [];

  await writeFile(file, CLI);

  const session = openClaudeStreamSession({
    bin: process.execPath,
    args: [file],
    cwd: dir,
    env: process.env,
    hooks: {
      onBackgroundTasks: (tasks) => {
        received.push(structuredClone(tasks));
        busy.push(session.busy);
      },
      onProviderUsage: () => {
        waiters.shift()?.();

        return true;
      },
      onBackgroundStart: () => backgrounds.push('start'),
    },
  });

  t.after(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Барьер квоты гарантирует обработку всех кадров после result до следующего ввода.
   * Таймаут означает ошибку синтетического CLI, а не ожидаемый RED новой функциональности.
   */
  async function send(before = [], after = []) {
    let timer;
    const consumed = new Promise((resolve, reject) => {
      waiters.push(resolve);
      timer = setTimeout(() => reject(new Error('CLI не прислал барьер квоты')), 2000);
    });

    try {
      const result = await session.send({ message: JSON.stringify({ before, after }) });

      await consumed;

      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    session,
    received,
    backgrounds,
    busy,
    send,
  };
}

test('BG-WIRE-01: снимки внутри хода и после result заменяют список, включая пустой', async (t) => {
  const f = await fixture(t);
  const first = rawTask('a', 'local_agent', 'Проверяет файл');
  const second = rawTask('b', 'local_bash', 'sleep 90');

  await f.send([snapshot([first])], [snapshot([second]), snapshot([second]), snapshot([])]);
  assert.deepEqual(f.received[0], [{
    id: 'a',
    kind: 'subagent',
    description: 'Проверяет файл',
  }],
    'process hook получает снимок ещё внутри managed-хода');
  assert.equal(f.received.some((tasks) => tasks.length === 1 && tasks[0].id === 'b'), true,
    'после result наблюдается новый полный снимок, а не добавление к прежнему');
  assert.deepEqual(f.received.at(-1), [], 'пустой снимок очищает состав');
  assert.equal(f.busy[0], true, 'первый callback пришёл во время заказанного хода');
  assert.equal(f.busy.at(-1), false, 'последний callback пришёл между ходами');
  assert.deepEqual(f.backgrounds, [], 'снимки между ходами не открывают непрошеный ход');
  assert.equal(f.session.alive, true);
});

test('BG-WIRE-02: нейтральные категории, исходные описания и фильтрация служебных задач', async (t) => {
  const f = await fixture(t);
  const tasks = [
    rawTask('agent', 'local_agent', 'core.cores'),
    rawTask('mcp', 'monitor_mcp', 'Следит за файлом'),
    rawTask('ws', 'monitor_ws', 'Следит за сокетом'),
    rawTask('bash', 'local_bash', '<b>данные</b>'),
    rawTask('workflow', 'local_workflow', 'Рабочий процесс'),
    rawTask('remote', 'remote_agent', 'Удалённая задача'),
    rawTask('ambient', 'local_bash', 'Служебная', { ambient: true }),
    rawTask('awaited', 'local_agent', 'Ожидаемая внутри хода', { awaited: true }),
    null,
    { description: 'Нет идентификатора и типа' },
  ];

  await f.send([snapshot(tasks), snapshot('не массив')]);

  assert.deepEqual(f.received.at(-1), [
    {
      id: 'agent',
      kind: 'subagent',
      description: 'core.cores',
    },
    {
      id: 'mcp',
      kind: 'monitor',
      description: 'Следит за файлом',
    },
    {
      id: 'ws',
      kind: 'monitor',
      description: 'Следит за сокетом',
    },
    {
      id: 'bash',
      kind: 'command',
      description: '<b>данные</b>',
    },
    {
      id: 'workflow',
      kind: 'other',
      description: 'Рабочий процесс',
    },
    {
      id: 'remote',
      kind: 'other',
      description: 'Удалённая задача',
    },
  ], 'ошибочный tasks не очищает прежний снимок; наружу выходят только нейтральные поля');
  assert.equal(f.session.alive, true);
});

for (const order of ['snapshot-first', 'started-first']) {
  test(`BG-WIRE-03: Monitor и Bash различаются через tool_use_id, порядок ${order}`, async (t) => {
    const f = await fixture(t);
    const tools = {
      type: 'assistant',
      message: {
        id: 'assistant-tools',
        content: [
          {
            type: 'tool_use',
            id: 'tool-monitor',
            name: 'Monitor',
            input: { command: 'tail -f file' },
          },
          {
            type: 'tool_use',
            id: 'tool-bash',
            name: 'Bash',
            input: { command: 'sleep 90' },
          },
        ],
      },
    };
    const started = ['monitor', 'bash'].map((id) => ({
      type: 'system',
      subtype: 'task_started',
      task_id: id,
      tool_use_id: `tool-${id}`,
      task_type: 'local_bash',
      description: 'Одинаковое описание',
    }));
    const active = snapshot(['monitor', 'bash'].map((id) =>
      rawTask(id, 'local_bash', 'Одинаковое описание')));
    const frames = order === 'snapshot-first' ? [active, ...started] : [...started, active];

    await f.send([tools, ...frames]);

    assert.deepEqual(f.received.at(-1), [
      {
        id: 'monitor',
        kind: 'monitor',
        description: 'Одинаковое описание',
      },
      {
        id: 'bash',
        kind: 'command',
        description: 'Одинаковое описание',
      },
    ], 'категория определяется связью с инструментом, а не текстом описания');

    await f.send([snapshot([]), ...started]);

    assert.deepEqual(f.received.at(-1), [], 'поздний task_started не воскрешает завершённую задачу');
  });
}
