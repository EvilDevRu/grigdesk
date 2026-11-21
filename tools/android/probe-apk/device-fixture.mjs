// Автономная loopback-фикстура для DEVICE-пробы 3a (образец qwenNativeFixture.mjs,
// без импортов репозитория — запускается настоящим Bionic Node на устройстве).
// Настоящий Qwen CLI видит только этот локальный OpenAI-compatible API с
// синтетическим ключом; ответы несут уникальную метку probe-3a-<runId>.
// Запуск: libnode.so device-fixture.mjs --port 47900 --run-id probe-3a-1
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);

  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number.parseInt(option('--port', '47900'), 10);
const runId = option('--run-id', 'probe-3a-0');
const apiKey = 'probe-3a-synthetic-key';
const marker = `${runId}-answer`;
const logFile = option('--log', 'fixture-requests.jsonl');

let sequence = 0;
let barrierReleased = false;
const barrierWaiters = [];

writeFileSync('fixture-marker.txt', `${marker}\n`);

const completion = (content, stream) => {
  sequence += 1;
  const id = `${marker}-${sequence}`;

  if (!stream) {
    return JSON.stringify({
      id,
      object: 'chat.completion',
      created: 1,
      model: 'probe-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'probe-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
  const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };

  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (url.pathname === '/barrier' && request.method === 'GET') {
    if (barrierReleased) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ released: true, runId }));

      return;
    }

    barrierWaiters.push(response);

    return;
  }

  if (url.pathname === '/release' && request.method === 'POST') {
    barrierReleased = true;

    for (const waiter of barrierWaiters.splice(0)) {
      waiter.writeHead(200, { 'Content-Type': 'application/json' });
      waiter.end(JSON.stringify({ released: true, runId }));
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ released: true }));

    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'probe-model' }] }));

    return;
  }

  let text = '';

  for await (const chunk of request) {
    text += chunk;
  }

  const auth = request.headers.authorization ?? '';

  if (auth !== `Bearer ${apiKey}`) {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'synthetic key required' }));

    return;
  }

  const body = JSON.parse(text);

  appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), url: url.pathname, body })}\n`);

  const content = `Ответ настоящего CLI: ${marker}-${sequence + 1}`;
  const stream = body.stream === true;
  const payload = completion(content, stream);

  response.writeHead(200, {
    'Content-Type': stream ? 'text/event-stream' : 'application/json',
  });
  response.end(payload);
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ fixture: runId, port, marker, apiKey }));
});