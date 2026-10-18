#!/usr/bin/env node
// Фикстура Claude в режиме stream-json: принимает user-сообщения из stdin и отвечает
// событиями. Первое сообщение открывает ход и НЕ завершает его — фикстура ждёт уточнение,
// как настоящий CLI, который принимает дополнительный ввод в активный ход.
//
// Модель не вызывается: merge вливает уточнение после tool_result с одним result,
// next-turn запускает уточнение после итога задачи с новым system/init.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, writeSync } from 'node:fs';

const traceFile = process.env.GRIGDESK_CLAUDE_FIXTURE_TRACE || '';
const argv = process.argv.slice(2);
const SESSION_ID = 'session-claude-fixture';
const steersExpected = Math.max(1, Number(process.env.GRIGDESK_CLAUDE_FIXTURE_STEERS) || 1);
const mode = process.env.GRIGDESK_CLAUDE_FIXTURE_MODE || 'merge';
const replayEnabled = argv.includes('--replay-user-messages')
  && process.env.GRIGDESK_CLAUDE_FIXTURE_NO_LIFECYCLE !== '1';

function trace(entry) {
  if (traceFile) {
    appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

function send(message) {
  trace({ direction: 'server', message });
  writeSync(1, `${JSON.stringify(message)}\n`);
}

const inputAt = argv.indexOf('--input-format');

if (inputAt < 0 || argv[inputAt + 1] !== 'stream-json') {
  trace({ direction: 'fixture-error', message: 'нужен --input-format stream-json' });
  process.exit(64);
}
if (argv.includes('-p') && argv[argv.indexOf('-p') + 1] && !argv[argv.indexOf('-p') + 1].startsWith('--')) {
  trace({ direction: 'fixture-error', message: 'текст хода должен приходить через stdin, а не argv' });
  process.exit(64);
}

trace({ direction: 'process', argv, pid: process.pid });

let messages = 0;
let buffer = '';
let original;
let stopped = false;
let backgroundRunning = false;
let backgroundStarted = false;
let lateRunning = false;
let pendingSend;
const injected = [];

/**
 * Формы lifecycle и replay повторяют живой stream-json, включая разные uuid события и команды.
 * Без флага CLI этих служебных подтверждений не присылает.
 */
function lifecycle(message, state) {
  if (!replayEnabled) {
    return;
  }

  send({
    type: 'command_lifecycle',
    command_uuid: message.uuid,
    state,
    uuid: randomUUID(),
    session_id: SESSION_ID,
  });
}

function replay(message) {
  if (!replayEnabled) {
    return;
  }

  send({
    type: 'user',
    message: message.message,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: message.uuid,
    timestamp: new Date().toISOString(),
    isReplay: true,
  });
}

/**
 * Барьер позволяет проверить состояние между queued, started и result без гонки таймеров.
 * Сценарии без барьера продолжаются сразу.
 */
function afterRelease(suffix, enabled, action) {
  if (!enabled) {
    action();

    return;
  }

  const barrier = setInterval(() => {
    if (!existsSync(`${traceFile}.${suffix}`)) {
      return;
    }

    clearInterval(barrier);
    action();
  }, 5);
}

/**
 * Result связан с UUID входа, а completed приходит уже после границы хода.
 * Это также проверяет, что служебный хвост не создаёт фоновый ответ.
 */
function result(message, text, index, subtype = 'success') {
  send({
    type: 'result',
    subtype,
    session_id: SESSION_ID,
    result: text,
    num_turns: 1,
    user_message_uuid: message.uuid,
    user_message_uuids: [message.uuid],
    queued_turn_count: injected.length,
    result_index: index,
    uuid: randomUUID(),
  });
  lifecycle(message, 'completed');
}

function toolResult(id) {
  send({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: 'Готово',
        is_error: false,
      }],
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

function assistant(id, content, parent = null) {
  send({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, content },
  });
}

/**
 * Каждый результат инструмента отделяет завершённое сообщение от следующего ответа модели.
 * Второе сообщение содержит несколько текстовых блоков вокруг вызова инструмента с тем же id.
 */
function startAssistantBlocks() {
  send({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
  });

  for (let index = 1; index <= 3; index += 1) {
    const id = `commentary-block-${index}`;

    assistant(id, [{ type: 'text', text: `Проверяю документ ${index}.` }]);

    if (index === 2) {
      assistant('subagent-message-1', [{ type: 'text', text: 'Вложенная реплика.' }], 'parent-tool-1');
      assistant(id, [{ type: 'thinking', thinking: 'Проверяю условия.' }]);
      assistant(id, [{ type: 'text', text: 'Продолжаю проверку.' }]);
    }

    assistant(index === 1 ? 'separate-tool-message' : id, [{
      type: 'tool_use',
      id: `synthetic-tool-${index}`,
      name: 'Bash',
      input: { command: 'true' },
    }]);

    if (index === 2) {
      assistant(id, [{ type: 'text', text: 'Команда подготовлена.' }]);
    }

    send({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: `synthetic-tool-${index}`,
          content: 'Готово',
        }],
      },
    });
  }

  const barrier = setInterval(() => {
    if (!existsSync(process.env.CLAUDE_BLOCKS_RELEASE)) {
      return;
    }

    clearInterval(barrier);
    assistant('assistant-final', [{ type: 'text', text: 'Проверка закончена.' }]);

    if (process.env.CLAUDE_BLOCKS_EXIT === '1') {
      setTimeout(() => process.exit(2), 10);

      return;
    }

    assistant('assistant-final', [{ type: 'text', text: 'Все документы проверены.' }]);
    send({
      type: 'result',
      session_id: SESSION_ID,
      subtype: 'success',
      result: 'Проверка закончена.\nВсе документы проверены.',
      num_turns: 3,
    });
    setTimeout(() => process.exit(0), 10);
  }, 5);
}

/**
 * Долгая команда: реплика и вызов инструмента с тем же id приходят сразу, а результат
 * ждёт файла-барьера, как Bash на минуты. Реплика обязана закрыться до результата.
 */
function startHeldTool() {
  send({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
  });
  assistant('held-tool-message', [{ type: 'text', text: 'Ветки нет — создам.' }]);
  assistant('held-tool-message', [{
    type: 'tool_use',
    id: 'synthetic-held-tool',
    name: 'Bash',
    input: { command: 'sleep 600' },
  }]);

  const barrier = setInterval(() => {
    if (!existsSync(process.env.CLAUDE_BLOCKS_RELEASE)) {
      return;
    }

    clearInterval(barrier);
    toolResult('synthetic-held-tool');
    assistant('held-tool-final', [{ type: 'text', text: 'Ветка создана.' }]);
    send({
      type: 'result',
      session_id: SESSION_ID,
      subtype: 'success',
      result: 'Ветка создана.',
      num_turns: 2,
    });
    setTimeout(() => process.exit(0), 10);
  }, 5);
}

/**
 * Первый ввод открывает задачу, уточнения либо вливаются в неё, либо запускаются следующим ходом.
 * Режимы завершения реплик сохраняют отдельные сценарии проверки блоков.
 */
function handle(message, index) {
  if (process.env.GRIGDESK_CLAUDE_FIXTURE_BLOCKS === '1') {
    if (index === 1) {
      startAssistantBlocks();
    }

    return;
  }
  if (process.env.GRIGDESK_CLAUDE_FIXTURE_BLOCKS === 'held-tool') {
    if (index === 1) {
      startHeldTool();
    }

    return;
  }

  if (index === 1) {
    original = message;
    lifecycle(message, 'queued');
    lifecycle(message, 'started');
    send({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
    });
    replay(message);

    if (mode !== 'next-turn') {
      assistant('assistant-first', [{ type: 'text', text: 'Начинаю проверку.' }]);
    }

    return;
  }

  if (stopped || (mode === 'late' && original.done)) {
    if (backgroundRunning || lateRunning) {
      pendingSend = message;
    } else {
      finishNewSend(message);
    }

    return;
  }

  injected.push(message);

  if (mode === 'late') {
    consumeLate(message);

    return;
  }

  lifecycle(message, 'queued');
  afterRelease('start',process.env.GRIGDESK_CLAUDE_FIXTURE_HOLD_START === '1', () => {
    if (!stopped) {
      consume(message, index);
    }
  });
}

/**
 * Порядок двух режимов повторяет живую пробу: в merge replay идёт перед started,
 * в next-turn started и новый init следуют за первым result.
 */
function consume(message, index) {
  const text = String(message.message?.content?.[0]?.text || '');

  if (mode === 'next-turn') {
    assistant('assistant-final', [{ type: 'text', text: 'Второй файл проверен.' }]);
    result(original, 'Второй файл проверен.', 1);
    afterRelease('next', true, () => {
      lifecycle(message, 'started');
      send({
        type: 'system',
        subtype: 'init',
        session_id: SESSION_ID,
      });
      replay(message);
      assistant('assistant-injected', [{ type: 'text', text: `Отвечаю: ${text}` }]);
      result(message, `Отвечаю: ${text}`, 2);
    });

    return;
  }

  toolResult(`synthetic-tool-${index}`);
  replay(message);
  lifecycle(message, 'started');

  const answerId = steersExpected === 1 ? 'assistant-injected' : `assistant-injected-${index - 1}`;

  assistant(answerId, [{ type: 'text', text: `Отвечаю: ${text}` }]);
  toolResult(`synthetic-followup-${index}`);
  lifecycle(message, 'completed');

  if (index - 1 < steersExpected) {
    return;
  }

  afterRelease('release', process.env.GRIGDESK_CLAUDE_FIXTURE_HOLD_FINAL === '1', () => {
    assistant('assistant-final', [{ type: 'text', text: 'Второй файл проверен.' }]);
    result(original, 'Второй файл проверен.', 1);
  });
}

/**
 * Уточнение записано в stdin в момент финала: result исходной задачи обгоняет queued.
 * CLI затем запускает его отдельным ходом, который адаптер уже не может считать своим.
 */
function consumeLate(message) {
  const text = String(message.message?.content?.[0]?.text || '');

  assistant('assistant-final', [{ type: 'text', text: 'Второй файл проверен.' }]);
  result(original, 'Второй файл проверен.', 1);
  original.done = true;
  lateRunning = true;
  lifecycle(message, 'queued');
  afterRelease('next', true, () => {
    lateRunning = false;
    lifecycle(message, 'started');
    send({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
    });
    replay(message);
    assistant('assistant-late', [{ type: 'text', text: `Отвечаю: ${text}` }]);
    result(message, `Отвечаю: ${text}`, 2);

    if (pendingSend) {
      finishNewSend(pendingSend);
    }
  });
}

/**
 * Следующий заказанный ход ждёт завершения оставшегося после stop уточнения.
 * Его собственный result позволяет проверить, что ответы двух запусков не перепутались.
 */
function finishNewSend(message) {
  lifecycle(message, 'started');
  send({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
  });
  replay(message);
  assistant('assistant-new', [{ type: 'text', text: 'Новый ход завершён.' }]);
  result(message, 'Новый ход завершён.', 3);
}

/**
 * Stop закрывает исходную задачу, но имитирует запуск уже поставленного в очередь ввода.
 * Новый send остаётся в очереди CLI, пока этот непрошеный ход не отдаст свой result.
 */
function interrupt(message) {
  if (stopped) {
    const running = backgroundRunning && backgroundStarted;

    // Ещё не начатую команду очередь отменяет, начатую — закрывает остановочным result.
    if (backgroundRunning && !backgroundStarted) {
      lifecycle(injected[0], 'cancelled');
    }

    backgroundRunning = false;

    if (running) {
      result(injected[0], '', 2, 'error_during_execution');
    }

    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {},
      },
    });

    if (running && pendingSend) {
      finishNewSend(pendingSend);
    }

    return;
  }

  stopped = true;
  backgroundRunning = injected.length > 0;
  result(original, '', 1, 'error_during_execution');
  send({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: message.request_id,
      response: {},
    },
  });

  if (!backgroundRunning) {
    return;
  }

  setTimeout(() => {
    const queued = injected[0];

    if (!backgroundRunning) {
      return;
    }

    backgroundStarted = true;
    lifecycle(queued, 'started');
    send({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
    });
    replay(queued);
    assistant('assistant-background', [{ type: 'text', text: 'Ответ после остановки.' }]);
    afterRelease('background', true, () => {
      if (!backgroundRunning) {
        return;
      }

      result(queued, 'Ответ после остановки.', 2);
      backgroundRunning = false;

      if (pendingSend) {
        finishNewSend(pendingSend);
      }
    });
  }, 20);
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();

  let newline;

  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);

    if (!line) {
      continue;
    }

    let message;

    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message?.type !== 'user') {
      if (message?.type === 'control_request' && message.request?.subtype === 'interrupt') {
        trace({ direction: 'client', message });
        interrupt(message);

        continue;
      }
      if (process.env.GRIGDESK_CLAUDE_FIXTURE_SETTINGS === '1' && message?.type === 'control_request') {
        trace({ direction: 'client', message });

        const settingsAt = argv.indexOf('--settings');
        const effective = settingsAt < 0 ? {} : JSON.parse(argv[settingsAt + 1]);

        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response: message.request.subtype === 'get_settings'
              ? {
                effective,
                sources: {},
                applied: {},
              }
              : {},
          },
        });
      }

      continue;
    }

    messages += 1;
    trace({ direction: 'client', message });
    handle(message, messages);
  }
});

process.stdin.on('end', () => process.exit(0));
