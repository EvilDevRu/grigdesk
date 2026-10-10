import { randomBytes } from 'node:crypto';

import { MobileInputError } from './errors.ts';

type Token = {
  device: string;
  resource: string;
  kind: string;
  identity: Record<string, unknown>;
  expiresAt: number;
};

/**
 * Выдаёт непрозрачный снимок ожидания, принадлежащий устройству и текущему boot.
 * Права проверяет mTLS guard, а identity проверяет общий владелец непосредственно перед эффектом.
 */
export class ActionTokens {
  private tokens = new Map<string, Token>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Хранит только ограниченное число снимков и удаляет истёкшие записи до нового выпуска.
   * Текст сообщения и секреты транспорта в token не копируются.
   */
  issue(device: string, resource: string, kind: string, identity: Record<string, unknown>): string {
    for (const [key, token] of this.tokens) {
      if (token.expiresAt <= this.now()) {
        this.tokens.delete(key);
      }
    }

    if (this.tokens.size >= 4096) {
      this.tokens.delete(this.tokens.keys().next().value!);
    }

    const key = randomBytes(24).toString('hex');

    this.tokens.set(key, {
      device,
      resource,
      kind,
      identity: structuredClone(identity),
      expiresAt: this.now() + 600000,
    });

    return key;
  }

  /**
   * Забирает один снимок перед командой: новый ключ операции не повторяет старое действие.
   * Повтор прежнего Idempotency-Key восстанавливается журналом раньше этого вызова.
   */
  take(device: string, resource: string, kind: string, value: unknown): Record<string, unknown> {
    const token = typeof value === 'string' ? this.tokens.get(value) : null;

    if (
      !token ||
      token.device !== device ||
      token.resource !== resource ||
      token.kind !== kind ||
      token.expiresAt <= this.now()
    ) {
      throw new MobileInputError('state_changed', 'Состояние изменилось; обновите карточку.', 409);
    }

    this.tokens.delete(String(value));

    return structuredClone(token.identity);
  }
}
