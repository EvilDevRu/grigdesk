import { createHash } from 'node:crypto';

import type { MobileChatPort } from '../chat/mobileHistory.ts';
import { decodeAccepted } from './contract.ts';
import { MobileInputError } from './errors.ts';
import type { OperationProof, OperationResult } from './idempotency.ts';
import { resourceId, text } from './facade/common.ts';

export type ChatDeliveryInput = {
  deviceId: string;
  chatId: string;
  clientId: string;
  text: string;
};

/**
 * Устойчивая identity не зависит от посредника, HTTP-подключения и boot мобильного сервиса.
 * Hash содержимого сохраняется у общего владельца и отвергает повтор id с другим текстом.
 */
export function chatDeliveryIdentity(input: ChatDeliveryInput) {
  resourceId(input.chatId);

  if (
    !/^d[a-f0-9]{8,32}$/.test(input.deviceId) ||
    typeof input.clientId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(input.clientId)
  ) {
    throw new MobileInputError('bad_request', 'Неверный идентификатор отправки.');
  }
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 20000) {
    throw new MobileInputError('bad_text', 'Сообщение должно содержать от 1 до 20000 символов.');
  }

  return {
    turnId: `m_${createHash('sha256')
      .update(JSON.stringify([input.deviceId, input.chatId, input.clientId]))
      .digest('hex')}`,
    contentHash: createHash('sha256').update(input.text.trim()).digest('hex'),
  };
}

/**
 * В intent пишется только identity сообщения, без текста, ключей транспорта и отдельного execution ledger.
 * Неверная форма команды остаётся обычным проверяемым POST, которому нельзя выдать ложное доказательство.
 */
export function chatOperationProof(
  deviceId: string,
  path: string,
  body: unknown,
): OperationProof | undefined {
  const target = /^\/api\/mobile\/v1\/chats\/([A-Za-z0-9_-]{1,64})\/messages$/.exec(
    path.split('?')[0]!,
  );

  if (!target || !body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  const value = body as {
    text: string;
    clientId: string;
  };

  try {
    const identity = chatDeliveryIdentity({
      deviceId,
      chatId: target[1]!,
      clientId: value.clientId,
      text: value.text,
    });

    return {
      kind: 'chat',
      chatId: target[1]!,
      clientId: value.clientId,
      ...identity,
    };
  } catch {
    return undefined;
  }
}

/**
 * Принятый durable ход подтверждает исход 202 даже после потери operation result при падении.
 * Нет точного совпадения в общем ledger — исход остаётся unknown и требует перечитывания.
 */
export async function recoverChatOperation(
  port: MobileChatPort,
  deviceId: string,
  proof: OperationProof,
): Promise<OperationResult | null> {
  const found = await port.recover({
    deviceId,
    ...proof,
  });

  return found
    ? {
        status: 202,
        body: decodeAccepted({
          accepted: true,
          clientId: proof.clientId,
          turnId: proof.turnId,
          state: found.state,
          duplicate: true,
        }),
      }
    : null;
}

/**
 * Тонкий адаптер назначает identity, не создавая своей очереди и не опрашивая active перед запуском.
 * Fresh durable chat, workspace, модель и запуск принадлежат прежнему admission сервера.
 */
export class MobileChatTurns {
  private port: MobileChatPort;

  constructor(port: MobileChatPort) {
    this.port = port;
  }

  /**
   * Повтор передаётся тому же admission с исходной identity; второй executor не запускается.
   * Ошибки проверок до приёма не создают серверную реплику пользователя.
   */
  async send(input: ChatDeliveryInput) {
    const identity = chatDeliveryIdentity(input);
    const result = await this.port.send({
      chatKey: input.chatId,
      turnId: identity.turnId,
      message: input.text.trim(),
      sentAt: Date.now(),
      owner: {
        deviceId: input.deviceId,
        clientId: input.clientId,
        contentHash: identity.contentHash,
      },
    });

    if (result.status >= 400) {
      const error = String(result.body.error || 'chat_error');
      const model = /model|executor|provider/.test(error);

      throw new MobileInputError(
        error === 'turn_conflict' ? 'delivery_conflict' : model ? 'model_unavailable' : error,
        text(result.body.message, 4000) || 'Сообщение не принято.',
        model ? 409 : result.status,
      );
    }

    return {
      status: 202,
      body: decodeAccepted({
        ...result.body,
        clientId: input.clientId,
        duplicate: result.body.duplicate === true,
      }),
    };
  }
}
