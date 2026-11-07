import type { ServerResponse } from 'node:http';

export interface AnthropicReply {
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  text?: string;
}

/**
 * Минимальный SSE Anthropic передаёт ровно один tool_use либо текст без внешнего API.
 * Настоящий CLI самостоятельно выбирает и исполняет инструмент из своей конфигурации.
 */
export function sendAnthropicMessage(response: ServerResponse, item: AnthropicReply): void {
  const tool = Boolean(item.name);
  const send = (type: string, data: unknown) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', {
    type: 'message_start',
    message: {
      id: 'fixture-message',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: tool
      ? {
        type: 'tool_use',
        id: item.id,
        name: item.name,
        input: {},
      }
      : { type: 'text', text: '' },
  });
  send('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: tool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(item.input) }
      : { type: 'text_delta', text: item.text ?? 'Ответ.' },
  });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send('message_stop', { type: 'message_stop' });
  response.end();
}
