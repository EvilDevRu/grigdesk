import type { GrigDeskLink, LinkEvent, LinkState, OperationIntent, RequestInput } from './types.ts';
import { parseQr } from './qr.ts';

type Options = {
  outbox?: OperationIntent[];
  responses?: Record<string, unknown>;
  state?: Partial<LinkState>;
  request?: (input: RequestInput) => Promise<{
    status: number;
    body: string;
  }>;
};

/**
 * Dev/test мост получает синтетические данные извне; release не включает fixtures.
 * Один mock повторяет generation, lock и durable outbox контракт нативного владельца.
 */
export class MockLink implements GrigDeskLink {
  state: LinkState;
  calls: RequestInput[] = [];
  private options: Options;
  private outbox: OperationIntent[] = [];
  private events = new Set<(event: LinkEvent) => void>();
  private states = new Set<(state: Partial<LinkState> & { state?: string }) => void>();
  private started = false;

  constructor(options: Options = {}) {
    this.options = options;
    this.outbox = structuredClone(options.outbox || []);
    this.state = {
      paired: true,
      brainName: 'Синтетический GrigDesk',
      deviceName: 'Тестовый телефон',
      deviceId: 'd12345678',
      relays: [
        {
          id: 'local',
          name: 'Дом',
          host: '127.0.0.1',
          port: 7443,
          state: 'online',
        },
      ],
      activeRelayId: 'local',
      unlocked: true,
      fontScale: 1,
      generation: 1,
      ...options.state,
    };
  }

  async getState() {
    return structuredClone(this.state);
  }

  /**
   * Добавление сохраняет identity мозга и отвергает случайную смену привязки.
   * Секрет QR не возвращается getState и не попадает в обычный список посредников.
   */
  async addFromText(input: { text: string }) {
    const payload = parseQr(input.text);

    this.state.brainName = payload.brain.name;
    this.state.paired = true;
    this.state.relays.push({
      id: payload.relay.id,
      name: payload.relay.name,
      host: payload.relay.host,
      port: payload.relay.port,
      state: 'online',
    });
    this.state.activeRelayId = payload.relay.id;
  }

  async scanQr() {
    return { text: '' };
  }

  async selectRelay(input: { id: string }) {
    this.state.activeRelayId = input.id;
    this.state.generation += 1;
  }

  async removeRelay(input: { id: string }) {
    this.state.relays = this.state.relays.filter((relay) => relay.id !== input.id);

    if (this.state.activeRelayId === input.id) {
      this.state.activeRelayId = null;
    }
  }

  async unlock() {
    this.state.unlocked = true;
    this.state.generation += 1;
  }

  /**
   * Подставной запрос сохраняет намерение до ответа и ограничивает память outbox.
   * Программируемый транспорт проверяет повторы без отдельного mock retry loop.
   */
  async request(input: RequestInput) {
    if (!this.state.unlocked || this.state.revoked) {
      return {
        status: 0,
        body: '{"error":"locked"}',
        generation: this.state.generation,
      };
    }

    this.calls.push(structuredClone(input));

    const generation = this.state.generation;
    const response = this.options.request
      ? await this.options.request(input)
      : {
          status: input.path.endsWith('/messages') ? 202 : 200,
          body: JSON.stringify(
            this.options.responses?.[input.path] || {
              error: 'mock_missing',
              message: 'Нет образца.',
            },
          ),
        };

    return {
      ...response,
      generation,
    };
  }

  async getOutbox() {
    return { items: structuredClone(this.outbox) };
  }

  /**
   * Новый intent появляется один раз; существующий ключ не меняет прежнее тело.
   * Ограничение очереди проверяется до отображения успешного сохранения.
   */
  async putOutbox(input: { item: OperationIntent }) {
    if (this.outbox.some((item) => item.idempotencyKey === input.item.idempotencyKey)) {
      return;
    }
    if (
      this.outbox.length >= 100 ||
      new TextEncoder().encode(JSON.stringify([...this.outbox, input.item])).length >
        2 * 1024 * 1024
    ) {
      throw new Error('Очередь отправки заполнена.');
    }

    this.outbox.push(structuredClone(input.item));
  }

  async removeOutbox(input: { idempotencyKey: string }) {
    this.outbox = this.outbox.filter((item) => item.idempotencyKey !== input.idempotencyKey);
  }

  async startEvents() {
    if (!this.started) {
      this.started = true;
      this.emit('ready', { api: 1 });
    }
  }

  async stopEvents() {
    this.started = false;
  }

  async fetchMedia(input: { chatId: string; ref: string }) {
    return input.ref.includes('error') ? { error: 'media_not_found' } : { path: '/icon-192.png' };
  }

  async downloadUpdate() {}

  async resetDevice() {
    this.state = {
      ...this.state,
      paired: false,
      unlocked: false,
      relays: [],
      activeRelayId: null,
      generation: this.state.generation + 1,
      revoked: false,
    };
    this.outbox = [];
    this.states.forEach((callback) => callback(this.state));
  }

  /**
   * Подписка имеет явное удаление, чтобы remount не удваивал обработку событий.
   * Тест передаёт старое generation отдельно и проверяет, что клиент его игнорирует.
   */
  async addListener(name: 'linkEvent' | 'linkState', callback: (value: any) => void) {
    const listeners = name === 'linkEvent' ? this.events : this.states;

    listeners.add(callback);

    return {
      remove: async () => {
        listeners.delete(callback);
      },
    };
  }

  emit(name: string, data: unknown, generation = this.state.generation) {
    if (this.started) {
      this.events.forEach((callback) =>
        callback({
          name,
          data: JSON.stringify(data),
          generation,
        }),
      );
    }
  }

  lock() {
    this.state.unlocked = false;
    this.state.generation += 1;
    this.states.forEach((callback) => callback(this.state));
  }
}
