#!/usr/bin/env node
// Фикстура Claude в режиме stream-json: принимает user-сообщения из stdin и отвечает
// событиями. Первое сообщение открывает ход и НЕ завершает его — фикстура ждёт уточнение,
// как настоящий CLI, который принимает дополнительный ввод в активный ход.
//
// Модель не вызывается: события синтетические. Сценарий задан так, чтобы проверить
// корреляцию result: ответ на уточнение закрывается своим result, исходный ход — своим.
import { appendFileSync, existsSync, writeSync } from 'node:fs';

const traceFile = process.env.COCKPIT_CLAUDE_FIXTURE_TRACE || '';
const argv = process.argv.slice(2);
const SESSION_ID = 'session-claude-fixture';
const steersExpected = Math.max(1, Number(process.env.COCKPIT_CLAUDE_FIXTURE_STEERS) || 1);

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

function handle(text, index) {
  if (index === 1) {
    send({ type: 'system', subtype: 'init', session_id: SESSION_ID });
    send({
      type: 'assistant',
      message: { id: 'assistant-first', content: [{ type: 'text', text: 'Начинаю проверку.' }] },
    });
    return;
  }

  const answerId = steersExpected === 1 ? 'assistant-injected' : `assistant-injected-${index - 1}`;
  send({
    type: 'assistant',
    message: { id: answerId, content: [{ type: 'text', text: `Отвечаю: ${text}` }] },
  });
  send({
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    result: `Отвечаю: ${text}`,
    num_turns: 1,
  });
  if (index - 1 < steersExpected) {
    return;
  }
  const finishOriginal = () => {
    send({
      type: 'assistant',
      message: { id: 'assistant-final', content: [{ type: 'text', text: 'Второй файл проверен.' }] },
    });
    send({
      type: 'result',
      subtype: 'success',
      session_id: SESSION_ID,
      result: 'Второй файл проверен.',
      num_turns: 1,
    });
    setTimeout(() => process.exit(0), 10);
  };

  if (process.env.COCKPIT_CLAUDE_FIXTURE_HOLD_FINAL !== '1') {
    finishOriginal();
    return;
  }

  const barrier = setInterval(() => {
    if (!existsSync(`${traceFile}.release`)) return;
    clearInterval(barrier);
    finishOriginal();
  }, 5);
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
      continue;
    }

    messages += 1;
    trace({ direction: 'client', message });
    handle(String(message.message?.content?.[0]?.text || ''), messages);
  }
});
