// Поддельный Tripo для тестов раздела «3D»: API v3 и CDN файлов на одном локальном порту.
// Настоящий Tripo в тестах не вызывается никогда: заказы стоят денег. Сценарий управляет
// задачами вручную (прогресс, успех, отказ) и может сломать отдачу файла на CDN.

import http from 'node:http';
import { createHash } from 'node:crypto';

// Независимые endpoint/type из снятой документации API v3 и официального CLI chains.
// Имена legacy task types картинок подтверждены CLI; новые неподтверждённые aliases не выдумываются.
const TYPE_BY_ENDPOINT = new Map([
  ['/v3/generation/text-to-model', 'text_to_model'],
  ['/v3/generation/image-to-model', 'image_to_model'],
  ['/v3/generation/multiview-to-model', 'multiview_to_model'],
  ['/v3/generation/image-to-splat', 'image_to_splat'],
  ['/v3/generation/text-to-image', 'text_to_image'],
  ['/v3/generation/image-to-image', 'generate_image'],
  ['/v3/generation/image-to-multiview', 'generate_multiview_image'],
  ['/v3/generation/edit-multiview', 'edit_multiview_image'],
  ['/v3/models/texture', 'texture_model'],
  ['/v3/models/stylize', 'stylize_model'],
  ['/v3/models/convert', 'convert_model'],
  ['/v3/mesh/decimate', 'highpoly_to_lowpoly'],
  ['/v3/mesh/uv', 'mesh_uv'],
  ['/v3/mesh/segment', 'mesh_segmentation'],
  ['/v3/mesh/complete', 'mesh_completion'],
  ['/v3/mesh/smartsegment', 'smartsegment_model'],
  ['/v3/animations/rig-check', 'animate_prerigcheck'],
  ['/v3/animations/rig', 'animate_rig'],
  ['/v3/animations/retarget', 'animate_retarget'],
]);

/**
 * Синтетический номер задачи: проверка приватных идентификаторов принимает только
 * такой вид UUID, настоящих номеров в тестах быть не должно.
 */
export function fakeTaskId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * Читает тело запроса целиком: сценарии маленькие, потоковая обработка не нужна.
 * Возвращает Buffer, разбор JSON делает обработчик.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

// Ответ в конверте Tripo: code, data или message.
function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

/**
 * Отдаёт файл CDN с поддержкой Range и подготовленными поломками: обрыв после
 * N байт, 403 «ссылка протухла», игнор Range с ответом 200.
 */
function serveCdn(request, response, bytes, faults) {
  const fault = faults.shift();

  if (fault?.kind === '403') {
    response.writeHead(403);
    response.end();

    return;
  }

  const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
  const matching = !request.headers['if-range'] || request.headers['if-range'] === etag;
  const match = matching ? /^bytes=(\d+)-$/.exec(String(request.headers.range ?? '')) : null;
  const start = match && fault?.kind !== 'ignore-range' ? Number(match[1]) : 0;

  if (start >= bytes.length && bytes.length > 0) {
    response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` });
    response.end();

    return;
  }

  const body = bytes.subarray(start);
  const headers = { 'Content-Length': String(body.length), ETag: etag };

  if (start > 0) {
    headers['Content-Range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
  }

  response.writeHead(start > 0 ? 206 : 200, headers);

  if (fault?.kind === 'drop') {
    response.write(body.subarray(0, fault.after ?? Math.floor(body.length / 2)));
    setImmediate(() => response.socket?.destroy());

    return;
  }

  response.end(body);
}

/**
 * Запускает поддельный Tripo. Возвращает адрес, окружение для клиента и ручки
 * управления: задачи, история трат, баланс, вынужденные ответы и поломки CDN.
 */
export async function startFakeTripo({ key = 'fixture-tripo-key' } = {}) {
  const tasks = new Map();
  const requests = [];
  const uploads = [];
  const files = new Map();
  const faults = new Map();
  const forced = [];
  const state = {
    counter: 0,
    usage: [],
    balance: {
      balance: 100,
      frozen: 0
    }
  };

  /**
   * Обработчик API. Порядок: CDN без ключа, проверка ключа, вынужденный ответ,
   * затем ручки по пути. Незнакомый путь — 404 с кодом Tripo.
   */
  const handle = async (request, response) => {
    const url = new URL(request.url, 'http://fake.test');
    const body = await readBody(request);

    if (url.pathname.startsWith('/cdn/')) {
      const name = decodeURIComponent(url.pathname.slice(5));
      const bytes = files.get(name);

      if (!bytes) {
        response.writeHead(404);
        response.end();

        return;
      }

      serveCdn(request, response, bytes, faults.get(name) ?? []);

      return;
    }

    let json = null;

    try {
      const isJson = String(request.headers['content-type']).includes('json');

      json = body.length && isJson ? JSON.parse(body) : null;
    } catch {
      json = null;
    }

    requests.push({
      method: request.method,
      path: url.pathname,
      body: json
    });

    if (request.headers.authorization !== `Bearer ${key}`) {
      sendJson(response, 401, {
        code: 1002,
        message: 'invalid api key'
      });

      return;
    }

    const forcedIndex = forced.findIndex((item) => {
      return item.method === request.method && item.path.test(url.pathname);
    });

    if (forcedIndex >= 0) {
      const [item] = forced.splice(forcedIndex, 1);

      if (item.drop) {
        request.socket.destroy();

        return;
      }

      sendJson(response, item.status, item.body, item.headers);

      return;
    }

    route(request, response, url, body, json);
  };

  /**
   * Ручки API v3: загрузка файла, пакетный опрос, одна задача, баланс, траты и
   * создание задач по известным адресам из каталога.
   */
  const route = (request, response, url, body, json) => {
    if (request.method === 'POST' && url.pathname === '/v3/files') {
      const name = /filename="([^"]+)"/.exec(body.toString('latin1'))?.[1] ?? 'file';

      uploads.push({
        name,
        size: body.length
      });
      sendJson(response, 200, {
        code: 0,
        data: { file_token: `file_${uploads.length}` }
      });

      return;
    }

    if (request.method === 'POST' && url.pathname === '/v3/tasks/list') {
      const ids = Array.isArray(json?.task_ids) ? json.task_ids : [];
      const found = Object.fromEntries(ids.filter((id) => tasks.has(id)).map((id) => [id, tasks.get(id)]));

      sendJson(response, 200, {
        code: 0,
        data: {
          tasks: found,
          missed: ids.filter((id) => !tasks.has(id))
        }
      });

      return;
    }

    const taskMatch = /^\/v3\/tasks\/([^/]+)$/.exec(url.pathname);

    if (request.method === 'GET' && taskMatch) {
      const task = tasks.get(decodeURIComponent(taskMatch[1]));

      sendJson(response, task ? 200 : 404, task ? {
        code: 0,
        data: task
      } : {
        code: 2001,
        message: 'task not found'
      });

      return;
    }

    if (request.method === 'GET' && url.pathname === '/v3/account/balance') {
      sendJson(response, 200, {
        code: 0,
        data: state.balance
      });

      return;
    }

    if (request.method === 'GET' && url.pathname === '/v3/account/usage') {
      sendJson(response, 200, {
        code: 0,
        data: state.usage
      });

      return;
    }

    createTask(request, response, url, json);
  };

  /**
   * Создаёт задачу по известному адресу каталога; незнакомый адрес — 404.
   * Номера идут по порядку, чтобы сценарии их предсказывали.
   */
  const createTask = (request, response, url, json) => {
    const type = TYPE_BY_ENDPOINT.get(url.pathname);

    if (request.method !== 'POST' || !type) {
      sendJson(response, 404, {
        code: 404,
        message: 'not found'
      });

      return;
    }

    state.counter += 1;

    const id = fakeTaskId(state.counter);

    tasks.set(id, {
      task_id: id,
      type,
      status: 'queued',
      progress: 0,
      input: json ?? {},
      output: {},
      created_at: '2026-10-11T10:00:00Z'
    });
    sendJson(response, 200, {
      code: 0,
      data: { task_id: id }
    });
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => response.destroy());
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    key,
    env: {
      TRIPO_API_KEY: key,
      TRIPO_REGION: 'ov'
    },
    tasks,
    requests,
    uploads,
    cdnUrl: (name) => `${baseUrl}/cdn/${encodeURIComponent(name)}`,
    setFile(name, bytes) {
      files.set(name, Buffer.from(bytes));
    },
    cdnFault(name, fault) {
      faults.set(name, [...(faults.get(name) ?? []), fault]);
    },
    progress(id, progress, eta = null) {
      Object.assign(tasks.get(id), {
        status: 'running',
        progress,
        running_left_time: eta
      });
    },
    complete(id, { output = {}, credits = null } = {}) {
      Object.assign(tasks.get(id), {
        status: 'success',
        progress: 100,
        output,
        credits_consumed: credits,
        completed_at: '2026-10-11T10:02:00Z'
      });
    },
    fail(id, { status = 'failed', code = 1001, message = 'internal' } = {}) {
      Object.assign(tasks.get(id), {
        status,
        error_code: code,
        error_message: message
      });
    },
    respondOnce(method, path, status, body, headers = {}) {
      forced.push({
        method,
        path,
        status,
        body,
        headers
      });
    },
    dropOnce(method, path) {
      forced.push({
        method,
        path,
        drop: true
      });
    },
    setUsage(list) {
      state.usage = list;
    },
    setBalance(balance) {
      state.balance = balance;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
