import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parseBrowserAction } from '../../../../shared/browser/browserActions.ts';

export interface MailboxContext {
  stateDir: string;
  task: string;
  stage: string;
  runId: string;
  epoch: string;
  nonce: string;
}

/**
 * Общий STATE_DIR не раскрывает соседнему агенту содержимое snapshot и ввода.
 * Ключ принадлежит одному run, а направление AAD исключает подстановку request как reply.
 */
function seal(context: MailboxContext, payload: Record<string, unknown>,
  kind: 'request' | 'reply' | 'ready',
) {
  if (!/^[a-f0-9]{64}$/u.test(context.nonce)) {
    throw new Error('browser_nonce_invalid');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(context.nonce, 'hex'), iv);
  const aad = JSON.stringify([1, context.task, context.stage, context.runId, context.epoch, kind]);

  cipher.setAAD(Buffer.from(aad));

  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);

  return {
    schema: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

/**
 * Любая подмена ciphertext, контекста или направления отвергается до разбора payload.
 * Ошибки криптографии не раскрывают модельные ключи и содержимое соседней очереди.
 */
function unseal(context: MailboxContext, envelope: Record<string, unknown>,
  kind: 'request' | 'reply' | 'ready',
) {
  if (!/^[a-f0-9]{64}$/u.test(context.nonce)
    || Object.keys(envelope).sort().join(',') !== 'data,iv,schema,tag' || envelope.schema !== 1
    || !['iv', 'tag', 'data'].every((key) => typeof envelope[key] === 'string'
      && /^[A-Za-z0-9+/]+={0,2}$/u.test(envelope[key] as string))) {
    throw new Error('browser_mailbox_signature');
  }

  try {
    const iv = Buffer.from(envelope.iv as string, 'base64');
    const tag = Buffer.from(envelope.tag as string, 'base64');

    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error('invalid_ciphertext');
    }

    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(context.nonce, 'hex'), iv);
    const aad = JSON.stringify([1, context.task, context.stage, context.runId, context.epoch, kind]);

    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);

    const bytes = Buffer.concat([
      decipher.update(Buffer.from(envelope.data as string, 'base64')), decipher.final(),
    ]);

    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('browser_mailbox_signature');
  }
}

/**
 * Служебный путь полностью выводится из identity текущего запуска.
 * Ни model input, ни filename запроса не задают соседний control directory.
 */
async function directoryFor(context: MailboxContext): Promise<string> {
  if (!/^[1-9][0-9]*$/u.test(context.task) || !/^[A-Z][A-Z0-9_]*$/u.test(context.stage)
    || ! /^[A-Za-z0-9._-]{1,160}$/u.test(context.runId) || ['.', '..'].includes(context.runId)
    || !/^[1-9][0-9]*$/u.test(context.epoch)
    || !path.isAbsolute(context.stateDir)) {
    throw new Error('browser_run_invalid');
  }

  const directory = path.join(context.stateDir, 'logs', 'runs', `t${context.task}`,
    context.stage, context.runId, 'control-requests', 'browser');

  if (await realpath(directory) !== directory) {
    throw new Error('browser_mailbox_invalid');
  }

  return directory;
}

/**
 * O_NOFOLLOW и размер проверяются по открытому дескриптору, не только через lstat.
 * JSON никогда не выполняется как shell либо JavaScript.
 */
async function readJson(file: string, limit: number): Promise<Record<string, unknown>> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('browser_mailbox_invalid');
    }

    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead > limit) {
      throw new Error('browser_mailbox_invalid');
    }

    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Публикация атомарна; читатель не увидит половину тела запроса.
 * Temporary принадлежит текущему writer и удаляется при отказе rename.
 */
async function publish(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);

  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.close();
    await rename(temporary, file);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Один вызов создаёт один request и ожидает ровно его reply с ограниченным сроком.
 * published — тестовый/host lifecycle барьер, не доступный аргумент модели.
 */
export async function browserMailboxRequest(options: {
  context: MailboxContext;
  id?: string;
  input: unknown;
  signal?: AbortSignal;
  published?(): void;
}) {
  const directory = await directoryFor(options.context);
  const id = options.id ?? randomUUID();

  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)) {
    throw new Error('browser_request_invalid');
  }

  const request = path.join(directory, `${id}.browser`);
  const reply = path.join(directory, `${id}.reply`);
  const deadline = Date.now() + 15000;

  await publish(request, seal(options.context, {
    schema: 1,
    id,
    deadline,
    input: parseBrowserAction(options.input),
  }, 'request'));
  options.published?.();

  try {
    while (Date.now() < deadline && !options.signal?.aborted) {
      const envelope = await readJson(reply, 4 * 1024 * 1024).catch((error) => {
        if (error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });

      if (envelope) {
        const result = unseal(options.context, envelope, 'reply');

        if (result.schema !== 1 || result.id !== id) {
          throw new Error('browser_reply_invalid');
        }

        if (result.error) {
          throw new Error(String(result.error));
        }

        return result.result;
      }

      await delay(25, undefined, { signal: options.signal });
    }

    throw new Error(options.signal?.aborted ? 'browser_cancelled' : 'outcome_unknown');
  } finally {
    await unlink(request).catch(() => undefined);
    await unlink(reply).catch(() => undefined);
  }
}

/**
 * Один trusted relay последовательно читает только свой run mailbox.
 * Полномочие замкнуто в invoke и не берётся из request JSON.
 */
export async function browserMailboxOnce(options: {
  context: MailboxContext;
  invoke(input: unknown): Promise<unknown>;
  signal?: AbortSignal;
  seen?: Set<string>;
  replied?(envelope: unknown): void;
}) {
  const directory = await directoryFor(options.context);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.browser')).sort();

  for (const filename of files.slice(0, 32)) {
    if (options.signal?.aborted) {
      return;
    }

    const id = filename.slice(0, -'.browser'.length);

    if (!/^[a-f0-9-]{36}$/u.test(id)) {
      throw new Error('browser_request_invalid');
    }

    const file = path.join(directory, filename);
    const request = unseal(options.context, await readJson(file, 65536), 'request');
    const seen = options.seen;
    let value: unknown;

    try {
      if (Object.keys(request).sort().join(',') !== 'deadline,id,input,schema'
        || request.schema !== 1 || request.id !== id || typeof request.deadline !== 'number'
        || request.deadline < Date.now() || request.deadline > Date.now() + 16000) {
        throw new Error('browser_request_invalid');
      }

      if (seen?.has(id)) {
        throw new Error('outcome_unknown');
      }

      if (seen && seen.size >= 4096) {
        throw new Error('browser_run_limit');
      }

      seen?.add(id);
      value = { result: await options.invoke(parseBrowserAction(request.input)) };
    } catch (error) {
      value = { error: /^browser_|^outcome_unknown$|^access_revoked$/u.test((error as Error).message)
        ? (error as Error).message : 'browser_unavailable' };
    }

    const replyEnvelope = seal(options.context, {
      schema: 1,
      id,
      ...(value as object)
    }, 'reply');

    options.replied?.(replyEnvelope);
    await publish(path.join(directory, `${id}.reply`), replyEnvelope);
    await unlink(file).catch(() => undefined);
  }
}

/**
 * Readiness шифруется тем же run key и не позволяет соседней задаче подменить routing.
 * Направление ready отделено от request/reply через AAD.
 */
export async function writeBrowserReady(context: MailboxContext, mode: 'legacy' | 'grigdesk',
  evidenceRoot: string | null = null,
) {
  const directory = await directoryFor(context);

  await publish(path.join(directory, 'host.ready'), seal(context, { mode, evidenceRoot }, 'ready'));
}

/**
 * Provider bridge читает только подтверждённый режим своего запуска после barrier.
 * Отсутствие или подмена readiness не разрешает переход к отдельному браузеру.
 */
export async function readBrowserReadyDetails(context: MailboxContext): Promise<{
  mode: 'legacy' | 'grigdesk';
  evidenceRoot: string | null;
}> {
  const directory = await directoryFor(context);
  const envelope = await readJson(path.join(directory, 'host.ready'), 4096);
  const value = unseal(context, envelope, 'ready');

  if (Object.keys(value).sort().join(',') !== 'evidenceRoot,mode'
    || !['legacy', 'grigdesk'].includes(String(value.mode))
    || value.evidenceRoot !== null && (typeof value.evidenceRoot !== 'string'
      || !path.isAbsolute(value.evidenceRoot) || /[\r\n\0]/u.test(value.evidenceRoot))) {
    throw new Error('browser_ready_invalid');
  }

  return { mode: value.mode as 'legacy' | 'grigdesk', evidenceRoot: value.evidenceRoot as string | null };
}

/**
 * Обычный consumer readiness получает только enum режима, без filesystem адресов.
 * Подробности пути нужны лишь host builder native filesystem map до model spawn.
 */
export async function readBrowserReady(context: MailboxContext): Promise<'legacy' | 'grigdesk'> {
  return (await readBrowserReadyDetails(context)).mode;
}
