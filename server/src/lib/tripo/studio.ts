// Tripo разделяет чистый план, бесплатную подготовку входов и единственную отправку.
// Ключ остаётся в снимке клиента; журнал получает только accountKey и конкретный childId.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

import { CREDIT_FORMS } from '../../../../shared/studio3d/studio3dOperations.ts';
import { ProviderFailure } from '../studio3d/provider.ts';
import { openVerified } from '../studio3d/safePath.ts';
import type {
  AccountSnapshot,
  PlannedTask,
  ResolvedInput,
  Studio3dProvider,
  SubmitRequest,
} from '../studio3d/provider.ts';
import {
  NATIVE_ONLY,
  TASK_OPERATIONS,
  USD_PER_CREDIT,
  nativeAccepts,
  recognizeTripoRecord,
  tripoOperations,
  tripoPool,
  tripoQuote,
  tripoRequests,
  tripoValidate,
} from './catalog.ts';
import type { TripoInputs, TripoRequest } from './catalog.ts';
import { createTripoClient } from './client.ts';
import type { TripoClient, TripoClientDeps } from './client.ts';

const TOKEN_TTL_MS = 20 * 60 * 1000;

interface CachedToken {
  token: string;
  at: number;
}

export interface TripoStudioDeps extends TripoClientDeps {
  client?: TripoClient;
  now?: () => number;
}

/**
 * Native-only шаг отказывает до оплаты, если происхождение или доступность не доказаны.
 * Сохранённый файл не становится задачей скелета/сегментации у Tripo.
 */
function needsTripoVersion(operation: string): ProviderFailure {
  const what: Readonly<Record<string, string>> = {
    animate: 'скелет, поставленный Tripo',
    'complete-parts': 'разрезка, сделанная Tripo',
    'views-edit': 'виды, сделанные Tripo',
  };

  return new ProviderFailure({
    kind: 'input',
    code: null,
    message: `Для этого шага нужна версия, где ${what[operation] ?? 'результат Tripo'}.`,
    detail: null,
    retryAfterMs: null,
  }, false);
}

/**
 * Подтверждает sha256 с открытого fd и неизменность source вокруг бесплатной загрузки.
 * Одинаковые path/mtime не являются ключом кеша, hardlink не является своим снимком.
 */
async function verifiedHash(file: string, root: string): Promise<{ sha256: string; revision: string }> {
  const opened = await openVerified(root, file);

  try {
    const hash = createHash('sha256');

    for await (const bytes of createReadStream(opened.canonical, {
      fd: opened.handle.fd,
      autoClose: false,
      start: 0
    })) {
      hash.update(bytes);
    }

    await opened.verify();

    return { sha256: hash.digest('hex'), revision: opened.revision };
  } finally {
    await opened.handle.close();
  }
}

/**
 * Создаёт исполнителя без сетевых эффектов. Каждая операция использует одну пару
 * ключ/API, pure plan сохраняет параметры каждого клипа для recovery без planIndex.
 */
export function createTripoStudio(deps: TripoStudioDeps = {}): Studio3dProvider {
  const client = deps.client ?? createTripoClient(deps);
  const now = deps.now ?? Date.now;
  const tokens = new Map<string, CachedToken>();
  let currentAccount = '';

  /**
   * Смена доступа очищает краткоживущие кеши; старый отпечаток не даёт права
   * отправлять новый запрос. Возврат ключа восстанавливает jobs через журнал.
   */
  const snapshot = (): AccountSnapshot => {
    const captured = client.snapshot();

    if (captured.accountKey !== currentAccount) {
      currentAccount = captured.accountKey;
      tokens.clear();
    }

    return captured;
  };

  /**
   * Кеш принадлежит аккаунту и содержимому. Файл проверяется после upload,
   * поэтому правка не закрепляет токен других байтов под прежним SHA.
   */
  const tokenFor = async (file: string, captured: AccountSnapshot,
    root = path.dirname(file)): Promise<string> => {
    const before = await verifiedHash(file, root);
    const key = `${captured.accountKey}:${before.sha256}`;
    const cached = tokens.get(key);

    if (cached && now() - cached.at < TOKEN_TTL_MS) {
      return cached.token;
    }

    const token = await client.upload(file, captured, root);
    const after = await verifiedHash(file, root);

    if (before.revision !== after.revision || before.sha256 !== after.sha256) {
      throw needsTripoVersion('upload');
    }

    tokens.set(key, { token, at: now() });

    return token;
  };

  /**
   * Native допускается после бесплатного preflight в том же аккаунте. Истёкший
   * источник заменяется файлом только у операций, которые принимают файл.
   */
  const refFor = async (
    operation: string,
    input: ResolvedInput,
    captured: AccountSnapshot,
  ): Promise<string> => {
    const native = input.native;

    if (native?.accountKey === captured.accountKey && nativeAccepts(operation, native.taskType)) {
      try {
        const source = await client.getTask(native.taskId, captured);

        if (source.state === 'success' && source.type === native.taskType) {
          return native.taskId;
        }
      } catch (error) {
        if (!(error instanceof ProviderFailure) || !['expired', 'not-found'].includes(error.error.kind)) {
          throw error;
        }
      }
    }

    if (NATIVE_ONLY.has(operation) || !input.file) {
      throw needsTripoVersion(operation);
    }

    return tokenFor(input.file.path, captured, input.file.root);
  };

  /**
   * Подготовка сохраняет именованные виды и использует общий native ID лишь после
   * проверки всех входов. Клипы имеют одинаковые входы, но собственные values.
   */
  const inputsFor = async (request: SubmitRequest, captured: AccountSnapshot): Promise<TripoInputs> => {
    const primary = request.inputs.find((input) => input.role === 'primary');
    const views = request.inputs.filter((input) => input.role !== 'primary');

    if (request.operation !== 'views-to-model') {
      return primary ? { primary: await refFor(request.operation, primary, captured) } : {};
    }

    const native = views[0]?.native;

    if (native?.accountKey === captured.accountKey
      && views.every((view) => view.native?.taskId === native.taskId
        && view.native.accountKey === captured.accountKey)
      && nativeAccepts('views-to-model', native.taskType)) {
      const source = await client.getTask(native.taskId, captured).catch((error) => {
        if (!(error instanceof ProviderFailure) || !['expired', 'not-found'].includes(error.error.kind)) {
          throw error;
        }

        return null;
      });

      if (source?.state === 'success' && source.type === native.taskType) {
        return { viewsTask: native.taskId };
      }
    }

    const refs: TripoInputs['views'] = {};

    for (const view of views) {
      const role = view.role as 'front' | 'left' | 'back' | 'right';

      refs[role] = await refFor(request.operation, view, captured);
    }

    return { views: refs };
  };

  return {
    id: 'tripo',
    name: 'Tripo',
    local: false,
    unit: CREDIT_FORMS,
    usdPerUnit: USD_PER_CREDIT,
    available: () => client.available(),
    cancelReads: () => client.cancelReads(),
    snapshot,
    isCurrent: (captured) => client.isCurrent(captured),
    operations: tripoOperations,
    validate: tripoValidate,
    quote: tripoQuote,
    nativeAccepts,
    pool: tripoPool,
    balance: (captured) => client.balance(captured ?? snapshot()),
    plan(request) {
      return tripoRequests(request.operation, request.values, {}, request.context).map((item, index) => {
        const values = item.endpoint.endsWith('/retarget')
          ? { ...request.values, animations: [String(item.body.animation)] }
          : request.values;

        return {
          childId: `child-${index + 1}`,
          label: item.label,
          values: structuredClone(values),
          taskType: item.taskType,
          payload: { request: structuredClone({ ...request, values }) },
        };
      });
    },
    /**
     * Подготовка загружает бесплатные входы снимка, не создавая заказ. Child
     * содержит ровно свои параметры, поэтому restart не меняет выбранный клип.
     */
    async prepare(task, captured) {
      const request = (task.payload as { request: SubmitRequest }).request;
      const inputs = await inputsFor(request, captured);
      const built = tripoRequests(request.operation, task.values, inputs, request.context);

      if (built.length !== 1) {
        throw needsTripoVersion(request.operation);
      }

      return {
        ...task,
        payload: { ...built[0]!, accountKey: captured.accountKey }
      };
    },
    send(task, captured) {
      const payload = task.payload as TripoRequest & { accountKey: string };

      if (!client.isCurrent(captured) || payload.accountKey !== captured.accountKey || !payload.endpoint) {
        return Promise.reject(needsTripoVersion('send'));
      }

      return client.createTask(payload.endpoint, payload.body, captured).then((taskId) => ({
        taskId,
        taskType: payload.taskType
      }));
    },
    poll: (ids, captured) => client.listTasks(ids, captured ?? snapshot()),
    history: (captured) => client.usage(captured ?? snapshot()),
    recognizeRecord: recognizeTripoRecord,
    taskOperation: (type) => TASK_OPERATIONS[type] ?? null,
  };
}
