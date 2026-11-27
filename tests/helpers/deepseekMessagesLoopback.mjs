import { createServer } from 'node:http';

/**
 * Отправляет синтетический ответ Messages с теми же текстом, reasoning и вызовами.
 * Дельты одного текстового блока остаются отдельными SSE-событиями.
 */
export function writeDeepSeekMessagesReply(response, model, { deltas, finishReason }) {
  const send = (type, data = {}) => response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
  );

  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: {
    id: 'msg_loopback',
    model,
    usage: { input_tokens: 8 },
  } });

  let index = -1;
  let open;

  /**
   * Дельты текста и reasoning продолжают открытый блок.
   * Каждый вызов инструмента получает собственный индекс.
   */
  function start(type, content) {
    if (open === type && type !== 'tool_use') {
      return;
    }
    if (open) {
      send('content_block_stop', { index });
    }

    index += 1;
    open = type;
    send('content_block_start', { index, content_block: { type, ...content } });
  }

  for (const delta of deltas) {
    if (typeof delta.reasoning_content === 'string') {
      start('thinking', { thinking: '' });
      send('content_block_delta', {
        index, delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }
    if (typeof delta.content === 'string') {
      start('text', { text: '' });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: delta.content } });
    }

    for (const call of delta.tool_calls ?? []) {
      start('tool_use', {
        id: call.id,
        name: call.function.name,
        input: {},
      });
      send('content_block_delta', {
        index, delta: { type: 'input_json_delta', partial_json: call.function.arguments },
      });
    }
  }

  if (open) {
    send('content_block_stop', { index });
  }

  const stopReason = { tool_calls: 'tool_use', length: 'max_tokens' }[finishReason] ?? 'end_turn';

  send('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } });
  send('message_stop');
  response.end();
}

/**
 * Принимает только синтетические Messages-запросы от тестового Harness.
 * SSE выполняет полный lifecycle текстового ответа alpha.2.
 */
export async function startDeepSeekMessagesLoopback(model) {
  const payloads = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end();

      return;
    }

    let body = '';

    for await (const chunk of request) {
      body += chunk;
    }

    payloads.push(JSON.parse(body));

    writeDeepSeekMessagesReply(response, model, {
      deltas: [{ content: 'loopback-ok' }],
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    payloads,
    /** Дожидается освобождения порта даже после отмены открытого запроса. */
    async stop() {
      server.closeAllConnections();

      await new Promise((resolve) => server.close(resolve));
    },
  };
}
